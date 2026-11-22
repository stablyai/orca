// What this computer keeps about asks from agents on servers it is paired to: the agents its people
// introduced in a server's chat, the servers they allowed to ask an agent without asking each time,
// the asks waiting for a person or for admission, and which pairing it last announced itself under.
// A server is known by its installation id, which outlives a re-pair; `environment_id` is only the
// pairing to reach it by, rewritten when the same server answers under another.
import type { OrchestrationDb } from '../orchestration-db'

export const PAIRED_SERVER_ASKS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS paired_server_introductions (
  server_installation_id TEXT NOT NULL,
  root_session           TEXT NOT NULL,
  bot_id                 TEXT NOT NULL,
  environment_id         TEXT NOT NULL,
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (server_installation_id, root_session, bot_id)
);
CREATE INDEX IF NOT EXISTS idx_paired_server_introductions_environment
  ON paired_server_introductions(environment_id);
CREATE TABLE IF NOT EXISTS paired_server_allowances (
  server_installation_id TEXT NOT NULL,
  bot_id                 TEXT NOT NULL,
  environment_id         TEXT NOT NULL,
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (server_installation_id, bot_id)
);
CREATE INDEX IF NOT EXISTS idx_paired_server_allowances_environment
  ON paired_server_allowances(environment_id);
CREATE TABLE IF NOT EXISTS paired_server_asks (
  message_id             TEXT PRIMARY KEY,
  conversation_id        TEXT NOT NULL,
  server_installation_id TEXT NOT NULL,
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
  server_installation_id  TEXT PRIMARY KEY,
  environment_id          TEXT NOT NULL,
  pairing_fingerprint     TEXT NOT NULL,
  server_seen_fingerprint TEXT NOT NULL
);
`

export type PairedServerAskRow = {
  message_id: string
  conversation_id: string
  server_installation_id: string
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
  row: { serverInstallationId: string; rootSession: string; botId: string; environmentId: string }
): void {
  db.db
    .prepare(
      `INSERT INTO paired_server_introductions (server_installation_id, root_session, bot_id, environment_id)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(server_installation_id, root_session, bot_id) DO UPDATE SET environment_id = excluded.environment_id`
    )
    .run(row.serverInstallationId, row.rootSession, row.botId, row.environmentId)
}

export function isIntroduced(
  db: OrchestrationDb,
  serverInstallationId: string,
  rootSession: string,
  botId: string
): boolean {
  return (
    db.db
      .prepare(
        `SELECT 1 FROM paired_server_introductions
         WHERE server_installation_id = ? AND root_session = ? AND bot_id = ?`
      )
      .get(serverInstallationId, rootSession, botId) !== undefined
  )
}

export function allowServer(
  db: OrchestrationDb,
  row: { serverInstallationId: string; botId: string; environmentId: string }
): void {
  db.db
    .prepare(
      `INSERT INTO paired_server_allowances (server_installation_id, bot_id, environment_id)
       VALUES (?, ?, ?)
       ON CONFLICT(server_installation_id, bot_id) DO UPDATE SET environment_id = excluded.environment_id`
    )
    .run(row.serverInstallationId, row.botId, row.environmentId)
}

export function removeServerAllowance(
  db: OrchestrationDb,
  serverInstallationId: string,
  botId: string
): void {
  db.db
    .prepare('DELETE FROM paired_server_allowances WHERE server_installation_id = ? AND bot_id = ?')
    .run(serverInstallationId, botId)
}

export function isServerAllowed(
  db: OrchestrationDb,
  serverInstallationId: string,
  botId: string
): boolean {
  return (
    db.db
      .prepare(
        'SELECT 1 FROM paired_server_allowances WHERE server_installation_id = ? AND bot_id = ?'
      )
      .get(serverInstallationId, botId) !== undefined
  )
}

export function listServerAllowances(
  db: OrchestrationDb,
  botId: string
): { serverInstallationId: string; environmentId: string }[] {
  return db.db
    .prepare(
      `SELECT server_installation_id, environment_id FROM paired_server_allowances
       WHERE bot_id = ? ORDER BY created_at, server_installation_id`
    )
    .all(botId)
    .map((row) => ({
      serverInstallationId: String(row.server_installation_id),
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
         message_id, conversation_id, server_installation_id, environment_id, root_session, bot_id, payload, state
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      row.message_id,
      row.conversation_id,
      row.server_installation_id,
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
export function rerouteServer(
  db: OrchestrationDb,
  serverInstallationId: string,
  environmentId: string
): void {
  for (const table of ROUTED_TABLES) {
    db.db
      .prepare(`UPDATE ${table} SET environment_id = ? WHERE server_installation_id = ?`)
      .run(environmentId, serverInstallationId)
  }
}

/** The pairing was removed: what it carried goes with it. The announced row stays, so a later
 *  pairing can still name the one it replaced. */
export function forgetServerRoute(db: OrchestrationDb, environmentId: string): void {
  for (const table of ROUTED_TABLES) {
    db.db.prepare(`DELETE FROM ${table} WHERE environment_id = ?`).run(environmentId)
  }
}

export function routedServerInstallationIds(db: OrchestrationDb, environmentId: string): string[] {
  return db.db
    .prepare(
      `SELECT server_installation_id FROM paired_server_introductions WHERE environment_id = ?1
       UNION SELECT server_installation_id FROM paired_server_allowances WHERE environment_id = ?1
       UNION SELECT server_installation_id FROM paired_server_asks WHERE environment_id = ?1`
    )
    .all(environmentId)
    .map((row) => String(row.server_installation_id))
}

export type AnnouncedPairing = {
  environmentId: string
  pairingFingerprint: string
  serverSeenFingerprint: string
}

export function getAnnouncedPairing(
  db: OrchestrationDb,
  serverInstallationId: string
): AnnouncedPairing | undefined {
  const row = db.db
    .prepare('SELECT * FROM paired_server_announced WHERE server_installation_id = ?')
    .get(serverInstallationId)
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
  serverInstallationId: string,
  pairing: AnnouncedPairing
): void {
  db.db
    .prepare(
      `INSERT INTO paired_server_announced (
         server_installation_id, environment_id, pairing_fingerprint, server_seen_fingerprint
       ) VALUES (?, ?, ?, ?)
       ON CONFLICT(server_installation_id) DO UPDATE SET
         environment_id = excluded.environment_id,
         pairing_fingerprint = excluded.pairing_fingerprint,
         server_seen_fingerprint = excluded.server_seen_fingerprint`
    )
    .run(
      serverInstallationId,
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
