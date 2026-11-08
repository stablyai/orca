import type Database from '../../sqlite/sync-database'

export type JournalSqlAcceptedInputs = {
  latestAcceptedTurnSequence: number
  latestPersonAcceptedSequence: number
}

/** Admission provenance names its original card version, never a later edited card. */
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
    LEFT JOIN journal_card_versions AS card ON card.session_id=attempt.session_id AND card.epoch=attempt.epoch
      AND card.message_id=json_extract(attempt.payload_json,'$.queuedMessageId')
      AND card.version_sequence=attempt.source_card_sequence AND card.version_index=attempt.source_card_index
    WHERE attempt.session_id=? AND attempt.epoch=? AND attempt.dispatch_state='accepted' AND attempt.accepted_sequence IS NOT NULL
      AND CASE WHEN json_type(attempt.payload_json,'$.queuedMessageId') IS NOT NULL
        THEN card.message_id IS NOT NULL AND COALESCE(json_extract(card.payload_json,'$.unattended'),0)<>1
          AND json_type(card.payload_json,'$.body.from') IS NULL
        ELSE json_extract(attempt.payload_json,'$.source.kind')='user'
          OR (json_type(attempt.payload_json,'$.source') IS NULL AND json_extract(attempt.payload_json,'$.origin')='client') END
    ORDER BY attempt.accepted_sequence DESC LIMIT 1`)
    .get(...prefix)
  return {
    latestAcceptedTurnSequence: Number(latest?.accepted_sequence ?? 0),
    latestPersonAcceptedSequence: Number(person?.accepted_sequence ?? 0)
  }
}
