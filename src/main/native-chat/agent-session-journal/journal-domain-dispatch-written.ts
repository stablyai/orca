import type Database from '../../sqlite/sync-database'
import { appendJournalSqlEvent } from './journal-sql-event-tail'
import {
  readJournalDomainSubmissionAttempt,
  type JournalDomainSubmissionCommit,
  type JournalDomainSubmissionTarget
} from './journal-domain-submission-records'
import { advanceJournalDomainSubmissionRevision } from './journal-domain-submission-revision'
import type { JournalWriterOperation } from './journal-writer-command'

/** Stamp provider receipt once per pending handover. */
export function applyJournalDomainDispatchWritten(
  db: Database.Database,
  target: JournalDomainSubmissionTarget,
  operation: Extract<JournalWriterOperation, { kind: 'dispatch-written' }>,
  savedAt: number
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
    submission.writtenAt !== undefined ||
    !attempt.handover ||
    attempt.handover.sequence !== operation.handoverCursor.sequence ||
    target.epoch !== operation.handoverCursor.epoch ||
    attempt.handover.fence !== operation.fence ||
    operation.fence < Number(head.highest_fence) ||
    (!operation.providerReceipt && attempt.handover.scope?.kind !== 'thread')
  ) {
    return result
  }
  const written = { ...submission, writtenAt: operation.observedAt }
  const payload = JSON.stringify(written)
  advanceJournalDomainSubmissionRevision(db, target, operation.clientMessageId, payload)
  // Receipt leaves dispatch and request outcomes unchanged.
  db.prepare(`UPDATE journal_submission_attempts SET payload_json=?
    WHERE session_id=? AND epoch=? AND message_id=? AND current=1`).run(
    payload,
    target.sessionId,
    target.epoch,
    operation.clientMessageId
  )
  const sequence = cursor.sequence + 1
  appendJournalSqlEvent(
    db,
    target,
    sequence,
    savedAt,
    // Not `submissions`: that would rebuild the queue and resend the unchanged message.
    { items: [], submissions: [], cards: [], writtenSubmissions: [operation.clientMessageId] },
    { fence: operation.fence, observedAt: operation.observedAt }
  )
  result.cursor = { epoch: target.epoch, sequence }
  result.writtenOnly = true
  result.writtenSubmission = written
  return result
}
