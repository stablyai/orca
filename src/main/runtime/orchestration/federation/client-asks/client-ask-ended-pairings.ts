// The pairings of a paired computer's conversations here that have ended: the computer was removed,
// or it said a re-pair replaced them. Kept on disk, so a reply on one of their conversations is
// refused after a restart too, never queued for a pairing that will not pull again. A conversation
// keeps the pairing it was made under: mail never moves to another pairing or device.
import type { OrchestrationDb } from '../../db/orchestration-db'

export const ENDED_CLIENT_PAIRINGS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ended_client_pairings (
  environment_id         TEXT NOT NULL,
  peer_fingerprint       TEXT NOT NULL,
  ended_at               TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (environment_id, peer_fingerprint)
);`

/** Every pairing this Orca's conversations with that computer were made under has ended, except
 *  `currentPairing`, which it still pulls with. */
export function recordEndedClientPairings(
  db: OrchestrationDb,
  environmentId: string,
  currentPairing: string | null
): void {
  db.db
    .prepare(
      `INSERT OR IGNORE INTO ended_client_pairings (environment_id, peer_fingerprint)
       SELECT DISTINCT environment_id, peer_fingerprint FROM peer_mail_conversations
       WHERE role = 'home' AND environment_id = ?1 AND (?2 IS NULL OR peer_fingerprint <> ?2)`
    )
    .run(environmentId, currentPairing)
}

export function isEndedClientPairing(
  db: OrchestrationDb,
  environmentId: string,
  pairing: string
): boolean {
  return (
    db.db
      .prepare(
        'SELECT 1 FROM ended_client_pairings WHERE environment_id = ? AND peer_fingerprint = ?'
      )
      .get(environmentId, pairing) !== undefined
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
