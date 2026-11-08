import type Database from '../../sqlite/sync-database'

/** Only entering the pending population appends; continuing membership keeps its place. */
export function journalDomainSendingPhaseOrdinal(
  db: Database.Database,
  target: { sessionId: string; epoch: string },
  previous: number | null,
  pending: boolean
): number | null {
  if (!pending) {
    return null
  }
  if (previous !== null) {
    return previous
  }
  const tail = db
    .prepare(`SELECT sending_phase_ordinal FROM journal_submission_attempts
    WHERE session_id=? AND epoch=? AND current=1 AND sending_phase_ordinal IS NOT NULL
    ORDER BY sending_phase_ordinal DESC,message_id DESC LIMIT 1`)
    .get(target.sessionId, target.epoch)
  return Number(tail?.sending_phase_ordinal ?? 0) + 1
}
