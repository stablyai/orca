import type Database from '../../sqlite/sync-database'

/** Fork validation tracks public send changes, independently of streamed item revisions. */
export function advanceJournalDomainSubmissionRevision(
  db: Database.Database,
  target: { sessionId: string; epoch: string },
  messageId: string,
  payload: string
): void {
  db.prepare(`UPDATE journal_chat_state SET submissions_revision=submissions_revision+1
    WHERE session_id=? AND epoch=? AND NOT EXISTS(
      SELECT 1 FROM journal_submission_attempts
      WHERE session_id=? AND epoch=? AND message_id=? AND current=1 AND payload_json=?)`).run(
    target.sessionId,
    target.epoch,
    target.sessionId,
    target.epoch,
    messageId,
    payload
  )
}
