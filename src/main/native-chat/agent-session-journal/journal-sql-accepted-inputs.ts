import type Database from '../../sqlite/sync-database'

export type JournalSqlAcceptedInputs = {
  latestAcceptedTurnSequence: number
  latestPersonAcceptedSequence: number
}

/** Queued admissions read the provenance their attempt snapshotted, never a later edited card. */
export function readJournalSqlAcceptedInputs(
  db: Database.Database,
  prefix: readonly [string, string]
): JournalSqlAcceptedInputs {
  const latest = db
    .prepare(`SELECT accepted_sequence FROM journal_submission_attempts
    WHERE session_id=? AND epoch=? AND dispatch_state='accepted' AND accepted_sequence IS NOT NULL
    ORDER BY accepted_sequence DESC LIMIT 1`)
    .get(...prefix)
  const person = db
    .prepare(`SELECT attempt.accepted_sequence FROM journal_submission_attempts AS attempt
    WHERE attempt.session_id=? AND attempt.epoch=? AND attempt.dispatch_state='accepted' AND attempt.accepted_sequence IS NOT NULL
      AND CASE WHEN json_type(attempt.payload_json,'$.queuedMessageId') IS NOT NULL
        THEN attempt.admitted_personal=1
        ELSE json_extract(attempt.payload_json,'$.source.kind')='user'
          OR (json_type(attempt.payload_json,'$.source') IS NULL AND json_extract(attempt.payload_json,'$.origin')='client') END
    ORDER BY attempt.accepted_sequence DESC LIMIT 1`)
    .get(...prefix)
  return {
    latestAcceptedTurnSequence: Number(latest?.accepted_sequence ?? 0),
    latestPersonAcceptedSequence: Number(person?.accepted_sequence ?? 0)
  }
}
