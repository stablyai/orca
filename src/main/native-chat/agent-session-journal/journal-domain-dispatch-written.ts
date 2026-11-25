import type Database from '../../sqlite/sync-database'
import type {
  JournalDomainSubmissionCommit,
  JournalDomainSubmissionTarget
} from './journal-domain-submission-records'
import type { JournalWriterOperation } from './journal-writer-command'

/** Stamp provider receipt once per pending handover. */
export function applyJournalDomainDispatchWritten(
  db: Database.Database,
  target: JournalDomainSubmissionTarget,
  operation: Extract<JournalWriterOperation, { kind: 'dispatch-written' }>
): JournalDomainSubmissionCommit<undefined> {
  if (!db.isTransaction) {
    throw new Error('journal dispatch-written requires its writer transaction')
  }
  const head = db
    .prepare(
      `SELECT last_sequence,highest_fence FROM journal_chat_state WHERE session_id=? AND epoch=?`
    )
    .get(target.sessionId, target.epoch)
  if (!head) {
    throw new Error('journal dispatch-written targets a retired chat epoch')
  }
  const cursor = { epoch: target.epoch, sequence: Number(head.last_sequence) }
  const result: JournalDomainSubmissionCommit<undefined> = {
    cursor,
    value: undefined,
    coordinates: [],
    items: [],
    removedItemIds: [],
    receipts: [],
    cards: [],
    inputChanged: false
  }
  const { clientMessageId, handoverCursor, fence, observedAt, providerReceipt } = operation
  if (handoverCursor.epoch !== target.epoch || fence < Number(head.highest_fence)) {
    return result
  }
  // Cover the exact pending handover without loading its JSON or changing the wire record.
  const stamp = db
    .prepare(`INSERT INTO journal_dispatch_written
    (session_id,epoch,handover_sequence,written_at)
    SELECT session_id,epoch,?,? FROM journal_submission_attempts
      INDEXED BY journal_pending_dispatch_handover
    WHERE session_id=? AND epoch=? AND message_id=? AND current=1 AND dispatch_state='pending'
      AND json_extract(facts_json,'$.handover.sequence')=?
      AND json_extract(facts_json,'$.handover.fence')=?
      AND (? OR json_extract(facts_json,'$.handover.scope.kind')='thread')
    ON CONFLICT(session_id,epoch,handover_sequence) DO NOTHING`)
    .run(
      handoverCursor.sequence,
      observedAt,
      target.sessionId,
      target.epoch,
      clientMessageId,
      handoverCursor.sequence,
      fence,
      Number(providerReceipt === true)
    )
  if (stamp.changes === 0) {
    return result
  }
  db.prepare(`UPDATE journal_chat_state SET last_activity_at=MAX(last_activity_at,?)
    WHERE session_id=? AND epoch=?`).run(operation.observedAt, target.sessionId, target.epoch)
  result.writtenOnly = true
  return result
}

/** Called only after a receipt COMMIT error, inside a fresh write transaction. */
export function confirmJournalDispatchWritten(
  db: Database.Database,
  target: JournalDomainSubmissionTarget,
  operation: Extract<JournalWriterOperation, { kind: 'dispatch-written' }>
): boolean {
  const row = db
    .prepare(`SELECT written_at FROM journal_dispatch_written
      WHERE session_id=? AND epoch=? AND handover_sequence=?`)
    .get(target.sessionId, target.epoch, operation.handoverCursor.sequence)
  if (!row) {
    return false
  }
  if (row.written_at !== operation.observedAt) {
    throw new Error('journal receipt commit has an unexpected timestamp')
  }
  return true
}
