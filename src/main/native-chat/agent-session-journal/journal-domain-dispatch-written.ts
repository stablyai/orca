import type Database from '../../sqlite/sync-database'
import { appendJournalSqlEvent } from './journal-sql-event-tail'
import {
  readJournalDomainSubmissionAttempt,
  type JournalDomainSubmissionCommit,
  type JournalDomainSubmissionTarget
} from './journal-domain-submission-records'
import { writeJournalDomainDispatchAttempt } from './journal-domain-dispatch-attempt'
import type { JournalWriterOperation } from './journal-writer-command'

/** Stamp `writtenAt` on a pending send the provider took while running no other turn; one stamp per handover. */
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
  // A send handed over into a running turn waits for the provider to read it; its echo settles it.
  if (
    !attempt ||
    !submission ||
    submission.dispatchState !== 'pending' ||
    submission.writtenAt !== undefined ||
    !attempt.handover ||
    attempt.handover.fence !== operation.fence ||
    operation.fence < Number(head.highest_fence) ||
    attempt.handover.scope?.kind !== 'thread'
  ) {
    return result
  }
  writeJournalDomainDispatchAttempt(db, target, {
    ...attempt,
    submission: { ...submission, writtenAt: savedAt }
  })
  const sequence = cursor.sequence + 1
  appendJournalSqlEvent(
    db,
    target,
    sequence,
    savedAt,
    // Not `submissions`: that would rebuild the queue and resend the unchanged message.
    { items: [], submissions: [], cards: [], writtenSubmissions: [operation.clientMessageId] },
    { fence: operation.fence, observedAt: savedAt }
  )
  result.cursor = { epoch: target.epoch, sequence }
  result.writtenOnly = true
  return result
}
