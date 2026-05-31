"use strict";

const http = require("http");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = Number(process.env.PORT) || 3847;
const PUBLIC_GAME_URL =
  process.env.PUBLIC_GAME_URL ||
  "https://catmanlab.github.io/games/supergun/supergun.html";
const CHALLENGE_TTL_MS = 60_000;

/** @type {Map<string, Client>} */
const clients = new Map();
/** @type {Map<string, Match>} */
const matches = new Map();
/** @type {Map<string, Challenge>} */
const challenges = new Map();

/**
 * @typedef {object} Client
 * @property {import("ws").WebSocket} ws
 * @property {string} id
 * @property {string|null} username
 * @property {string|null} displayName
 * @property {string|null} color
 * @property {number|null} lat
 * @property {number|null} lon
 * @property {string|null} matchId
 * @property {string|null} pendingChallengeId
 */

/**
 * @typedef {object} Match
 * @property {string} id
 * @property {string} hostId
 * @property {string} guestId
 * @property {string} difficulty
 * @property {boolean} teamMode
 * @property {"lobby"|"playing"} state
 */

/**
 * @typedef {object} Challenge
 * @property {string} id
 * @property {string} fromId
 * @property {string} toId
 * @property {number} expiresAt
 */

function newId() {
  return crypto.randomBytes(8).toString("hex");
}

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function getClient(id) {
  return id ? clients.get(id) || null : null;
}

function rosterEntry(client) {
  return {
    id: client.id,
    username: client.username,
    displayName: client.displayName,
    color: client.color,
  };
}

function broadcastPresence() {
  const players = [];
  for (const client of clients.values()) {
    if (client.username && client.displayName) {
      players.push(rosterEntry(client));
    }
  }
  const payload = {
    type: "presence",
    count: players.length,
    players,
  };
  for (const client of clients.values()) {
    send(client.ws, payload);
  }
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function findNearestClient(fromId) {
  const from = getClient(fromId);
  if (!from) return null;
  let best = null;
  let bestDist = Infinity;
  for (const other of clients.values()) {
    if (other.id === fromId || !other.username) continue;
    if (other.matchId || other.pendingChallengeId) continue;
    let dist = Infinity;
    if (
      from.lat != null &&
      from.lon != null &&
      other.lat != null &&
      other.lon != null
    ) {
      dist = haversineKm(from.lat, from.lon, other.lat, other.lon);
    }
    if (dist < bestDist) {
      bestDist = dist;
      best = other;
    }
  }
  if (best) return best;
  for (const other of clients.values()) {
    if (other.id === fromId || !other.username) continue;
    if (other.matchId || other.pendingChallengeId) continue;
    return other;
  }
  return null;
}

function removeChallenge(challengeId) {
  challenges.delete(challengeId);
}

function cancelChallengesForUsername(username) {
  if (!username) return;
  for (const [challengeId, ch] of challenges.entries()) {
    if (ch.fromUsername !== username && ch.toUsername !== username) continue;
    removeChallenge(challengeId);
    for (const c of clients.values()) {
      if (c.pendingChallengeId !== challengeId) continue;
      c.pendingChallengeId = null;
      send(c.ws, { type: "challenge_cancelled", challengeId });
    }
  }
}

function clearClientChallenge(client) {
  if (!client.username) {
    client.pendingChallengeId = null;
    return;
  }
  cancelChallengesForUsername(client.username);
  client.pendingChallengeId = null;
}

function notifyChallengeExpired(challengeId) {
  const ch = challenges.get(challengeId);
  if (!ch) return;
  removeChallenge(challengeId);
  for (const c of clients.values()) {
    if (c.username !== ch.fromUsername && c.username !== ch.toUsername) continue;
    if (c.pendingChallengeId === challengeId) c.pendingChallengeId = null;
    send(c.ws, { type: "challenge_expired", challengeId });
  }
  broadcastPresence();
}

function findClientByUsername(username) {
  if (!username) return null;
  for (const client of clients.values()) {
    if (client.username === username) return client;
  }
  return null;
}

function reattachClient(client) {
  if (!client.username) return;

  for (const ch of challenges.values()) {
    if (ch.toUsername === client.username) {
      ch.toId = client.id;
      client.pendingChallengeId = ch.id;
      send(client.ws, {
        type: "challenge_received",
        challengeId: ch.id,
        fromName: ch.fromName || "Someone",
      });
    } else if (ch.fromUsername === client.username) {
      ch.fromId = client.id;
      client.pendingChallengeId = ch.id;
      send(client.ws, {
        type: "challenge_sent",
        challengeId: ch.id,
        targetName: ch.toName || "Opponent",
      });
    }
  }

  for (const match of matches.values()) {
    let role = null;
    let opponent = null;
    if (match.hostUsername === client.username) {
      match.hostId = client.id;
      client.matchId = match.id;
      role = "host";
      opponent = findClientByUsername(match.guestUsername);
    } else if (match.guestUsername === client.username) {
      match.guestId = client.id;
      client.matchId = match.id;
      role = "guest";
      opponent = findClientByUsername(match.hostUsername);
    }
    if (!role) continue;
    send(client.ws, {
      type: "match_lobby",
      matchId: match.id,
      role,
      opponentName: opponent ? opponent.displayName : "Opponent",
      opponentColor: opponent ? opponent.color : "#888",
      difficulty: match.difficulty,
      teamMode: match.teamMode,
    });
  }
}

function endMatch(matchId, reason, excludeId) {
  const match = matches.get(matchId);
  if (!match) return;
  matches.delete(matchId);
  for (const pid of [match.hostId, match.guestId]) {
    if (pid === excludeId) continue;
    const c = getClient(pid);
    if (!c) continue;
    c.matchId = null;
    send(c.ws, { type: "match_ended", matchId, reason });
  }
  const host = getClient(match.hostId);
  const guest = getClient(match.guestId);
  if (host && host.matchId === matchId) host.matchId = null;
  if (guest && guest.matchId === matchId) guest.matchId = null;
}

function createChallenge(from, to) {
  cancelChallengesForUsername(from.username);
  cancelChallengesForUsername(to.username);
  from.pendingChallengeId = null;
  to.pendingChallengeId = null;
  const challengeId = newId();
  const challenge = {
    id: challengeId,
    fromId: from.id,
    toId: to.id,
    fromUsername: from.username,
    toUsername: to.username,
    fromName: from.displayName,
    toName: to.displayName,
    expiresAt: Date.now() + CHALLENGE_TTL_MS,
  };
  challenges.set(challengeId, challenge);
  from.pendingChallengeId = challengeId;
  to.pendingChallengeId = challengeId;
  send(from.ws, {
    type: "challenge_sent",
    challengeId,
    targetName: to.displayName,
  });
  send(to.ws, {
    type: "challenge_received",
    challengeId,
    fromName: from.displayName,
  });
  setTimeout(() => notifyChallengeExpired(challengeId), CHALLENGE_TTL_MS);
}

function startLobby(from, to) {
  removeChallenge(from.pendingChallengeId);
  removeChallenge(to.pendingChallengeId);
  from.pendingChallengeId = null;
  to.pendingChallengeId = null;
  const matchId = newId();
  const match = {
    id: matchId,
    hostId: from.id,
    guestId: to.id,
    hostUsername: from.username,
    guestUsername: to.username,
    difficulty: "intermediate",
    teamMode: true,
    state: "lobby",
  };
  matches.set(matchId, match);
  from.matchId = matchId;
  to.matchId = matchId;
  send(from.ws, {
    type: "match_lobby",
    matchId,
    role: "host",
    opponentName: to.displayName,
    opponentColor: to.color || "#fdcb6e",
    difficulty: match.difficulty,
    teamMode: match.teamMode,
  });
  send(to.ws, {
    type: "match_lobby",
    matchId,
    role: "guest",
    opponentName: from.displayName,
    opponentColor: from.color || "#4af0ff",
    difficulty: match.difficulty,
    teamMode: match.teamMode,
  });
  broadcastPresence();
}

function relayToMatchPeer(client, msg, allowedTypes) {
  if (!client.matchId) return;
  const match = matches.get(client.matchId);
  if (!match) return;
  if (!allowedTypes.includes(msg.type)) return;
  const peerId = client.id === match.hostId ? match.guestId : match.hostId;
  const peer = getClient(peerId);
  if (peer) send(peer.ws, msg);
}

function handleMessage(client, msg) {
  switch (msg.type) {
    case "register": {
      if (!msg.username || typeof msg.username !== "string") {
        send(client.ws, { type: "error", message: "Invalid username." });
        return;
      }
      client.username = msg.username.slice(0, 32);
      client.displayName = String(msg.displayName || msg.username).slice(0, 12);
      client.color = String(msg.color || "#4af0ff").slice(0, 16);
      send(client.ws, { type: "registered" });
      reattachClient(client);
      broadcastPresence();
      break;
    }
    case "update_location": {
      if (typeof msg.lat === "number" && typeof msg.lon === "number") {
        client.lat = msg.lat;
        client.lon = msg.lon;
      }
      break;
    }
    case "challenge_player": {
      if (!client.username) {
        send(client.ws, { type: "error", message: "Log in first." });
        return;
      }
      if (client.matchId) {
        send(client.ws, { type: "error", message: "Already in a match." });
        return;
      }
      const target = getClient(msg.targetId);
      if (!target || !target.username) {
        send(client.ws, { type: "error", message: "Player not found." });
        return;
      }
      if (target.id === client.id) {
        send(client.ws, { type: "error", message: "Cannot challenge yourself." });
        return;
      }
      createChallenge(client, target);
      broadcastPresence();
      break;
    }
    case "challenge_nearest": {
      if (!client.username) {
        send(client.ws, { type: "error", message: "Log in first." });
        return;
      }
      const nearest = findNearestClient(client.id);
      if (!nearest) {
        send(client.ws, { type: "error", message: "No other players online." });
        return;
      }
      createChallenge(client, nearest);
      broadcastPresence();
      break;
    }
    case "challenge_response": {
      const ch = challenges.get(msg.challengeId);
      if (!ch) {
        send(client.ws, { type: "challenge_expired", challengeId: msg.challengeId });
        return;
      }
      const isRecipient =
        client.id === ch.toId ||
        (client.username && client.username === ch.toUsername);
      if (!isRecipient) {
        send(client.ws, { type: "error", message: "Not your challenge." });
        return;
      }
      ch.toId = client.id;
      let from = getClient(ch.fromId);
      if (!from || !from.username) {
        from = findClientByUsername(ch.fromUsername);
        if (from) ch.fromId = from.id;
      }
      removeChallenge(ch.id);
      if (from) from.pendingChallengeId = null;
      client.pendingChallengeId = null;
      if (!msg.accept) {
        if (from) send(from.ws, { type: "challenge_declined", challengeId: ch.id });
        send(client.ws, { type: "challenge_declined", challengeId: ch.id });
        broadcastPresence();
        return;
      }
      if (!from || !from.username) {
        send(client.ws, { type: "error", message: "Challenger offline." });
        return;
      }
      startLobby(from, client);
      break;
    }
    case "lobby_update": {
      if (!client.matchId) return;
      const match = matches.get(client.matchId);
      if (!match || client.id !== match.hostId || match.state !== "lobby") return;
      if (msg.difficulty) match.difficulty = String(msg.difficulty).slice(0, 32);
      if (msg.teamMode != null) match.teamMode = !!msg.teamMode;
      relayToMatchPeer(client, {
        type: "lobby_settings",
        difficulty: match.difficulty,
        teamMode: match.teamMode,
      }, ["lobby_settings"]);
      break;
    }
    case "match_start": {
      if (!client.matchId) return;
      const match = matches.get(client.matchId);
      if (!match || client.id !== match.hostId || match.state !== "lobby") return;
      if (msg.difficulty) match.difficulty = String(msg.difficulty).slice(0, 32);
      if (msg.teamMode != null) match.teamMode = !!msg.teamMode;
      match.state = "playing";
      const host = getClient(match.hostId);
      const guest = getClient(match.guestId);
      if (!host || !guest) {
        endMatch(match.id, "opponent_disconnected");
        return;
      }
      send(host.ws, {
        type: "match_start",
        matchId: match.id,
        role: "host",
        difficulty: match.difficulty,
        teamMode: match.teamMode,
        guestName: guest.displayName,
        guestColor: guest.color,
        opponentName: guest.displayName,
        opponentColor: guest.color,
      });
      send(guest.ws, {
        type: "match_start",
        matchId: match.id,
        role: "guest",
        difficulty: match.difficulty,
        teamMode: match.teamMode,
        hostName: host.displayName,
        hostColor: host.color,
      });
      break;
    }
    case "leave_match": {
      if (!client.matchId) return;
      endMatch(client.matchId, "cancelled", client.id);
      client.matchId = null;
      broadcastPresence();
      break;
    }
    case "player_input":
    case "game_state":
    case "game_over": {
      relayToMatchPeer(client, msg, ["player_input", "game_state", "game_over"]);
      break;
    }
    default:
      break;
  }
}

const server = http.createServer((req, res) => {
  if (req.url === "/health" || req.url === "/") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, players: clients.size }));
    return;
  }
  if (req.url === "/api/info") {
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(
      JSON.stringify({
        phoneLink: PUBLIC_GAME_URL,
        links: [PUBLIC_GAME_URL],
      })
    );
    return;
  }
  res.writeHead(404);
  res.end("Not found");
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  const id = newId();
  /** @type {Client} */
  const client = {
    ws,
    id,
    username: null,
    displayName: null,
    color: null,
    lat: null,
    lon: null,
    matchId: null,
    pendingChallengeId: null,
  };
  clients.set(id, client);
  send(ws, { type: "hello", clientId: id });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== "string") return;
    handleMessage(client, msg);
  });

  ws.on("close", () => {
    if (client.matchId) {
      const match = matches.get(client.matchId);
      if (match && match.state === "playing") {
        endMatch(client.matchId, "opponent_disconnected", client.id);
      }
    }
    clients.delete(id);
    broadcastPresence();
  });
});

server.listen(PORT, () => {
  console.log(`Supergun online server listening on :${PORT}`);
});
