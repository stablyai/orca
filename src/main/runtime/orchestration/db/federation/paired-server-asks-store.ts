// What this computer keeps about asks from agents on servers it is paired to: the agents its people
// introduced in a server's chat, the servers they allowed to ask an agent without asking each time,
// the asks waiting for a person or for admission, and which pairing it last announced itself under.
// A server is known by its host key's fingerprint, which outlives a re-pair and no other server can
// claim; `environment_id` is only the pairing to reach it by, rewritten when it answers under another.
import type { OrchestrationDb } from '../orchestration-db'

export const PAIRED_SERVER_ASKS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS paired_server_introductions (
  server_key             TEXT NOT NULL,
  root_session           TEXT NOT NULL,
  bot_id                 TEXT NOT NULL,
  environment_id         TEXT NOT NULL,
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (server_key, root_session, bot_id)
);
CREATE INDEX IF NOT EXISTS idx_paired_server_introductions_environment
  ON paired_server_introductions(environment_id);
CREATE TABLE IF NOT EXISTS paired_server_allowances (
  server_key             TEXT NOT NULL,
  bot_id                 TEXT NOT NULL,
  environment_id         TEXT NOT NULL,
  -- 0 once a person removed it: the server stays known, so its next ask shows a card.
  always                 INTEGER NOT NULL DEFAULT 1,
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (server_key, bot_id)
);
CREATE INDEX IF NOT EXISTS idx_paired_server_allowances_environment
  ON paired_server_allowances(environment_id);
CREATE TABLE IF NOT EXISTS paired_server_asks (
  message_id             TEXT PRIMARY KEY,
  conversation_id        TEXT NOT NULL,
  server_key             TEXT NOT NULL,
  environment_id         TEXT NOT NULL,
  root_session           TEXT NOT NULL,
  bot_id                 TEXT NOT NULL,
  payload                TEXT NOT NULL,
  state                  TEXT NOT NULL CHECK(state IN ('card', 'admit')),
  created_at             TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_paired_server_asks_environment
  ON paired_server_asks(environment_id, state);
CREATE TABLE IF NOT EXISTS paired_server_announced (
  server_key              TEXT PRIMARY KEY,
  environment_id          TEXT NOT NULL,
  pairing_fingerprint     TEXT NOT NULL,
  server_seen_fingerprint TEXT NOT NULL
);
`

export type PairedServerAskRow = {
  message_id: string
  conversation_id: string
  server_key: string
  environment_id: string
  root_session: string
  bot_id: string
  payload: string
  state: 'card' | 'admit'
  created_at: string
}

const ROUTED_TABLES = [
  'paired_server_introductions',
  'paired_server_allowances',
  'paired_server_asks'
] as const

export function recordIntroduction(
  db: OrchestrationDb,
  row: { serverKey: string; rootSession: string; botId: string; environmentId: string }
): void {
  db.db
    .prepare(
      `INSERT INTO paired_server_introductions (server_key, root_session, bot_id, environment_id)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(server_key, root_session, bot_id) DO UPDATE SET environment_id = excluded.environment_id`
    )
    .run(row.serverKey, row.rootSession, row.botId, row.environmentId)
}

export function isIntroduced(
  db: OrchestrationDb,
  serverKey: string,
  rootSession: string,
  botId: string
): boolean {
  return (
    db.db
      .prepare(
        `SELECT 1 FROM paired_server_introductions
         WHERE server_key = ? AND root_session = ? AND bot_id = ?`
      )
      .get(serverKey, rootSession, botId) !== undefined
  )
}

export function allowServer(
  db: OrchestrationDb,
  row: { serverKey: string; botId: string; environmentId: string }
): void {
  db.db
    .prepare(
      `INSERT INTO paired_server_allowances (server_key, bot_id, environment_id)
       VALUES (?, ?, ?)
       ON CONFLICT(server_key, bot_id) DO UPDATE SET environment_id = excluded.environment_id, always = 1`
    )
    .run(row.serverKey, row.botId, row.environmentId)
}

/** A person removed it: that server asks through a card again, from any of its chats. */
export function removeServerAllowance(db: OrchestrationDb, serverKey: string, botId: string): void {
  db.db
    .prepare('UPDATE paired_server_allowances SET always = 0 WHERE server_key = ? AND bot_id = ?')
    .run(serverKey, botId)
}

export function isServerAllowed(db: OrchestrationDb, serverKey: string, botId: string): boolean {
  return (
    db.db
      .prepare(
        'SELECT 1 FROM paired_server_allowances WHERE server_key = ? AND bot_id = ? AND always = 1'
      )
      .get(serverKey, botId) !== undefined
  )
}

/** A person once let this server ask the agent, allowed now or not. */
export function isServerKnown(db: OrchestrationDb, serverKey: string, botId: string): boolean {
  return (
    db.db
      .prepare('SELECT 1 FROM paired_server_allowances WHERE server_key = ? AND bot_id = ?')
      .get(serverKey, botId) !== undefined
  )
}

export function listServerAllowances(
  db: OrchestrationDb,
  botId: string
): { serverKey: string; environmentId: string }[] {
  return db.db
    .prepare(
      `SELECT server_key, environment_id FROM paired_server_allowances
       WHERE bot_id = ? AND always = 1 ORDER BY created_at, server_key`
    )
    .all(botId)
    .map((row) => ({
      serverKey: String(row.server_key),
      environmentId: String(row.environment_id)
    }))
}

/** Inserts an ask once; a replayed pull finds it and changes nothing. */
export function holdPairedServerAsk(
  db: OrchestrationDb,
  row: Omit<PairedServerAskRow, 'created_at'>
): void {
  db.db
    .prepare(
      `INSERT OR IGNORE INTO paired_server_asks (
         message_id, conversation_id, server_key, environment_id, root_session, bot_id, payload, state
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      row.message_id,
      row.conversation_id,
      row.server_key,
      row.environment_id,
      row.root_session,
      row.bot_id,
      row.payload,
      row.state
    )
}

export function getPairedServerAsk(
  db: OrchestrationDb,
  messageId: string
): PairedServerAskRow | undefined {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT * over this table returns exactly its row shape.
  return db.db.prepare('SELECT * FROM paired_server_asks WHERE message_id = ?').get(messageId) as
    | PairedServerAskRow
    | undefined
}

export function listPairedServerAsks(
  db: OrchestrationDb,
  filter: { state: 'card' | 'admit'; environmentId?: string }
): PairedServerAskRow[] {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT * over this table returns exactly its row shape.
  return db.db
    .prepare(
      `SELECT * FROM paired_server_asks WHERE state = ?1 AND (?2 IS NULL OR environment_id = ?2)
       ORDER BY created_at, message_id`
    )
    .all(filter.state, filter.environmentId ?? null) as PairedServerAskRow[]
}

/** A person's answer: only the first one to find the card waiting changes it. */
export function admitPairedServerCard(db: OrchestrationDb, messageId: string): boolean {
  return (
    db.db
      .prepare(
        `UPDATE paired_server_asks SET state = 'admit' WHERE message_id = ? AND state = 'card'`
      )
      .run(messageId).changes > 0
  )
}

export function dropPairedServerAsk(
  db: OrchestrationDb,
  messageId: string,
  onlyState?: 'card'
): boolean {
  return (
    db.db
      .prepare('DELETE FROM paired_server_asks WHERE message_id = ? AND (?2 IS NULL OR state = ?2)')
      .run(messageId, onlyState ?? null).changes > 0
  )
}

/** The pairing the server is reached by changed: every row of that server follows it. */
export function rerouteServer(db: OrchestrationDb, serverKey: string, environmentId: string): void {
  for (const table of ROUTED_TABLES) {
    db.db
      .prepare(`UPDATE ${table} SET environment_id = ? WHERE server_key = ?`)
      .run(environmentId, serverKey)
  }
}

/** The pairing was removed: what it carried goes with it. The announced row stays, so a later
 *  pairing can still name the one it replaced. */
export function forgetServerRoute(db: OrchestrationDb, environmentId: string): void {
  for (const table of ROUTED_TABLES) {
    db.db.prepare(`DELETE FROM ${table} WHERE environment_id = ?`).run(environmentId)
  }
}

export type AnnouncedPairing = {
  environmentId: string
  pairingFingerprint: string
  serverSeenFingerprint: string
}

export function getAnnouncedPairing(
  db: OrchestrationDb,
  serverKey: string
): AnnouncedPairing | undefined {
  const row = db.db
    .prepare('SELECT * FROM paired_server_announced WHERE server_key = ?')
    .get(serverKey)
  return row
    ? {
        environmentId: String(row.environment_id),
        pairingFingerprint: String(row.pairing_fingerprint),
        serverSeenFingerprint: String(row.server_seen_fingerprint)
      }
    : undefined
}

export function recordAnnouncedPairing(
  db: OrchestrationDb,
  serverKey: string,
  pairing: AnnouncedPairing
): void {
  db.db
    .prepare(
      `INSERT INTO paired_server_announced (
         server_key, environment_id, pairing_fingerprint, server_seen_fingerprint
       ) VALUES (?, ?, ?, ?)
       ON CONFLICT(server_key) DO UPDATE SET
         environment_id = excluded.environment_id,
         pairing_fingerprint = excluded.pairing_fingerprint,
         server_seen_fingerprint = excluded.server_seen_fingerprint`
    )
    .run(
      serverKey,
      pairing.environmentId,
      pairing.pairingFingerprint,
      pairing.serverSeenFingerprint
    )
}

/** Servers this computer has a reason to pull asks from: something routed by them, or a reply owed. */
export const PAIRED_SERVER_ASK_ENVIRONMENTS_SQL = `
SELECT environment_id FROM paired_server_introductions
UNION SELECT environment_id FROM paired_server_allowances
UNION SELECT environment_id FROM paired_server_asks
UNION SELECT c.environment_id FROM peer_mail_conversations c
  JOIN federation_relay_items i ON i.dispatch_id = c.conversation_id
  WHERE c.role = 'peer' AND c.environment_id IS NOT NULL
    AND i.direction = 'to_home' AND i.acked_at IS NULL`

/** One server's arm of the pull loop's reason to run. */
export const PAIRED_SERVER_ASK_WANTS_SQL = `
SELECT 1 FROM paired_server_introductions WHERE environment_id = ?1
UNION ALL
SELECT 1 FROM paired_server_allowances WHERE environment_id = ?1
UNION ALL
SELECT 1 FROM paired_server_asks WHERE environment_id = ?1
UNION ALL
SELECT 1 FROM peer_mail_conversations c
  JOIN federation_relay_items i ON i.dispatch_id = c.conversation_id
  WHERE c.role = 'peer' AND c.environment_id = ?1 AND i.direction = 'to_home' AND i.acked_at IS NULL`

/** Whether a server's loop pulls for asks: then it waits on the server's first status read. */
export function pairedServerAsksWanted(db: OrchestrationDb, environmentId: string): boolean {
  return db.db.prepare(`${PAIRED_SERVER_ASK_WANTS_SQL} LIMIT 1`).get(environmentId) !== undefined
}
