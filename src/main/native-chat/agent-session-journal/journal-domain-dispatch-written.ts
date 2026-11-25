import type Database from '../../sqlite/sync-database'
import {
  readJournalDomainSubmissionAttempt,
  type JournalDomainSubmissionCommit,
  type JournalDomainSubmissionTarget
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
  const attempt = readJournalDomainSubmissionAttempt(db, target, operation.clientMessageId, false)
  const submission = attempt?.submission
  if (
    !attempt ||
    !submission ||
    submission.dispatchState !== 'pending' ||
    attempt.writtenAt !== undefined ||
    !attempt.handover ||
    attempt.handover.sequence !== operation.handoverCursor.sequence ||
    target.epoch !== operation.handoverCursor.epoch ||
    attempt.handover.fence !== operation.fence ||
    operation.fence < Number(head.highest_fence) ||
    (!operation.providerReceipt && attempt.handover.scope?.kind !== 'thread')
  ) {
    return result
  }
  // Leave the public payload and its sequence unchanged, including for a reader already catching up.
  db.prepare(`UPDATE journal_submission_attempts SET facts_json=json_set(facts_json,'$.writtenAt',?)
    WHERE session_id=? AND epoch=? AND message_id=? AND current=1`).run(
    operation.observedAt,
    target.sessionId,
    target.epoch,
    operation.clientMessageId
  )
  db.prepare(`UPDATE journal_chat_state SET last_activity_at=MAX(last_activity_at,?)
    WHERE session_id=? AND epoch=?`).run(operation.observedAt, target.sessionId, target.epoch)
  result.writtenOnly = true
  return result
}
