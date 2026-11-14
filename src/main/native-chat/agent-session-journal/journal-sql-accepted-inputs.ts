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
      AND attempt.admitted_personal=1
    ORDER BY attempt.accepted_sequence DESC LIMIT 1`)
    .get(...prefix)
  return {
    latestAcceptedTurnSequence: Number(latest?.accepted_sequence ?? 0),
    latestPersonAcceptedSequence: Number(person?.accepted_sequence ?? 0)
  }
}

export const JOURNAL_SQL_ACCEPTED_INPUT_COLUMNS = `
  (SELECT accepted_sequence FROM journal_submission_attempts
    WHERE session_id=head.session_id AND epoch=head.epoch AND dispatch_state='accepted'
      AND accepted_sequence IS NOT NULL ORDER BY accepted_sequence DESC LIMIT 1) AS latest_accepted,
  (SELECT accepted_sequence FROM journal_submission_attempts
    WHERE session_id=head.session_id AND epoch=head.epoch AND dispatch_state='accepted'
      AND accepted_sequence IS NOT NULL AND admitted_personal=1
    ORDER BY accepted_sequence DESC LIMIT 1) AS latest_person_accepted`
