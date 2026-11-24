// Whether the pairing a paired computer's conversation here was made under has ended. A
// conversation keeps that pairing: mail never moves to another pairing or device, so once it ended
// a reply there is refused rather than queued for a pairing that will never pull again. Two facts
// end it: this Orca recorded the end (the computer was removed, or said a re-pair replaced it), or
// the device registry no longer holds that device under that credential, which also covers a
// pairing removed before the record existed.
import type { OrchestrationDb } from '../../db/orchestration-db'
import type { ClientAskListenerOwner } from './client-ask-listeners'
import { runLifecycleWriteTransaction } from '../../db/lifecycle-write-transaction-runner'

export const CLIENT_ASKS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ended_client_pairings (
  environment_id         TEXT NOT NULL,
  peer_fingerprint       TEXT NOT NULL,
  ended_at               TEXT NOT NULL DEFAULT (datetime('now')),
  -- Who its askers hear it from and why, kept so an interrupted ending can finish after a restart.
  server_name            TEXT NOT NULL DEFAULT '',
  reason                 TEXT NOT NULL DEFAULT '',
  -- Set once its askers were told and its queue dropped; null: that is still owed.
  settled_at             TEXT,
  PRIMARY KEY (environment_id, peer_fingerprint)
);
-- An ask's card finds the ask it names by its id alone, and any later ask in the thread it opened.
CREATE INDEX IF NOT EXISTS idx_federation_relay_client_asks
  ON federation_relay_items(message_id) WHERE kind = 'client_ask';
CREATE INDEX IF NOT EXISTS idx_federation_relay_client_ask_threads
  ON federation_relay_items(dispatch_id, json_extract(payload, '$.threadId'))
  WHERE kind = 'client_ask';`

// Who an ended pairing's askers hear from, and why, when an earlier build kept neither.
const UNNAMED_END = { serverName: 'A paired computer', reason: 'Its pairing with this Orca ended.' }

// What an end still owes: a question there still awaits an answer, or mail queued there was never
// taken. For `ended_client_pairings` aliased `e`.
const OWES_SQL = `(EXISTS (SELECT 1 FROM peer_questions_out q
    WHERE q.awaiting = 1 AND q.peer_fingerprint = e.peer_fingerprint
      AND q.environment_id = e.environment_id)
  OR EXISTS (SELECT 1 FROM peer_mail_conversations c
    JOIN federation_relay_items i ON i.dispatch_id = c.conversation_id
    WHERE c.role = 'home' AND c.environment_id = e.environment_id
      AND c.peer_fingerprint = e.peer_fingerprint
      AND i.direction = 'to_worker' AND i.acked_at IS NULL))`

/** After `CLIENT_ASKS_SCHEMA_SQL`, once, at database open: an earlier build of this table kept only
 *  the pairing and when it ended, and could stop between recording an end and settling it. Its rows
 *  gain the columns in one write, so an interrupted upgrade starts over: one that still owes a
 *  notice or a drop stays unsettled for a restart to finish, under a plain sender and reason; the
 *  rest are settled. Then the unsettled-end index, which names the column. */
export function migrateEndedClientPairings(
  db: OrchestrationDb['db'],
  hasColumn: (table: string, column: string) => boolean
): void {
  const missing = ['server_name', 'reason', 'settled_at'].filter(
    (column) => !hasColumn('ended_client_pairings', column)
  )
  if (missing.length > 0) {
    runLifecycleWriteTransaction(db, 'ended_client_pairings_upgrade', () => {
      for (const column of missing) {
        db.exec(
          column === 'settled_at'
            ? 'ALTER TABLE ended_client_pairings ADD COLUMN settled_at TEXT'
            : `ALTER TABLE ended_client_pairings ADD COLUMN ${column} TEXT NOT NULL DEFAULT ''`
        )
      }
      db.prepare(
        `UPDATE ended_client_pairings
         SET server_name = CASE server_name WHEN '' THEN ?1 ELSE server_name END,
             reason = CASE reason WHEN '' THEN ?2 ELSE reason END`
      ).run(UNNAMED_END.serverName, UNNAMED_END.reason)
      if (missing.includes('settled_at')) {
        db.exec(`UPDATE ended_client_pairings AS e SET settled_at = ended_at WHERE NOT ${OWES_SQL}`)
      }
    })
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ended_client_pairings_unsettled
    ON ended_client_pairings(environment_id) WHERE settled_at IS NULL`)
}

/** The credential fingerprint a paired device holds now: null once it was removed, undefined when
 *  there is no registry to tell. */
export type PairedDeviceCredential = (deviceId: string) => string | null | undefined

const credentialsByOwner = new WeakMap<ClientAskListenerOwner, PairedDeviceCredential>()

/** The server that keeps this runtime's device registry names it here when it is made. */
export function registerPairedDeviceCredentials(
  owner: ClientAskListenerOwner,
  credentialOf: PairedDeviceCredential
): void {
  credentialsByOwner.set(owner, credentialOf)
}

/** The credential fingerprint the device registry holds for `deviceId` now (see
 *  `PairedDeviceCredential`). */
export function pairedDeviceCredential(
  owner: ClientAskListenerOwner,
  deviceId: string
): string | null | undefined {
  return credentialsByOwner.get(owner)?.(deviceId)
}

/** The pairing's end is recorded for these conversations: all of the environment's but
 *  `scope.keep`, which it still pulls with, or only `scope.only`. Unsettled until
 *  `markClientPairingsSettled`: its askers are owed a notice, and the queue a drop. */
export function recordEndedClientPairings(
  db: OrchestrationDb,
  environmentId: string,
  scope: ClientPairingScope,
  told: { serverName: string; reason: string }
): void {
  db.db
    .prepare(
      `INSERT INTO ended_client_pairings (environment_id, peer_fingerprint, server_name, reason)
       SELECT DISTINCT environment_id, peer_fingerprint, ?4, ?5 FROM peer_mail_conversations
       WHERE role = 'home' AND environment_id = ?1 AND ${clientPairingScopeSql('peer_fingerprint')}
       ON CONFLICT(environment_id, peer_fingerprint) DO UPDATE SET
         server_name = excluded.server_name, reason = excluded.reason, settled_at = NULL`
    )
    .run(environmentId, scope.keep ?? null, scope.only ?? null, told.serverName, told.reason)
}

/** Its askers were told and its queue dropped, in the write that did so. */
export function markClientPairingsSettled(
  db: OrchestrationDb,
  environmentId: string,
  scope: ClientPairingScope
): void {
  db.db
    .prepare(
      `UPDATE ended_client_pairings SET settled_at = datetime('now')
       WHERE environment_id = ?1 AND settled_at IS NULL AND ${clientPairingScopeSql('peer_fingerprint')}`
    )
    .run(environmentId, scope.keep ?? null, scope.only ?? null)
}

/** Ended pairings whose askers or queue were never settled (a crash or failure part way). */
export function listUnsettledClientPairings(db: OrchestrationDb): {
  environmentId: string
  pairing: string
  serverName: string
  reason: string
}[] {
  return db.db
    .prepare(
      `SELECT environment_id, peer_fingerprint, server_name, reason FROM ended_client_pairings
       WHERE settled_at IS NULL`
    )
    .all()
    .map((row) => ({
      environmentId: String(row.environment_id),
      pairing: String(row.peer_fingerprint),
      serverName: String(row.server_name),
      reason: String(row.reason)
    }))
}

/** Which pairings of an environment an end touches: all but `keep`, or only `only`; neither: all. */
export type ClientPairingScope = { keep?: string; only?: string }

/** The scope as SQL over `column`, with `?2` keep and `?3` only. */
export function clientPairingScopeSql(column: string): string {
  return `(?2 IS NULL OR ${column} <> ?2) AND (?3 IS NULL OR ${column} = ?3)`
}

/** Whether a conversation's pairing with the computer `deviceId` names has ended. */
export function isEndedClientPairing(
  owner: ClientAskListenerOwner,
  db: OrchestrationDb,
  conversation: { environmentId: string; deviceId: string; pairing: string }
): boolean {
  const held = pairedDeviceCredential(owner, conversation.deviceId)
  if (held !== undefined && held !== conversation.pairing) {
    return true
  }
  return (
    db.db
      .prepare(
        'SELECT 1 FROM ended_client_pairings WHERE environment_id = ? AND peer_fingerprint = ?'
      )
      .get(conversation.environmentId, conversation.pairing) !== undefined
  )
}

/** The computer pulled under that pairing's own credential: it has not ended, whatever a re-pair
 *  claimed. */
export function reviveClientPairing(
  db: OrchestrationDb,
  environmentId: string,
  pairing: string
): void {
  db.db
    .prepare('DELETE FROM ended_client_pairings WHERE environment_id = ? AND peer_fingerprint = ?')
    .run(environmentId, pairing)
}
