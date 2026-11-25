import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import { sameJournalCursor } from './replay/journal-cursor'
import type { SqlAgentSessionJournal } from './journal-sql-store'
import type { JournalWriterCommit } from './journal-writer-changes'
import type { JournalWriterOperation } from './journal-writer-command'
import type { AgentJournalSubmission } from '../../../shared/agent-session/journal/agent-session-journal-types'

type Receipt = {
  sequence: number
  handoverSequence: number
  submission: AgentJournalSubmission & { writtenAt: number }
}
type ReceiptProgress = {
  epoch: string
  after: number
  through: number
  at: number
  byId: Map<string, Receipt>
  ordered: Receipt[]
}
const recentReceipts = new WeakMap<SqlAgentSessionJournal, ReceiptProgress>()

/** Only the contiguous suffix of adopted receipts can extend a prior status read. */
export function adoptJournalStatusCursor(
  journal: SqlAgentSessionJournal,
  previous: AgentJournalCursor,
  commit: JournalWriterCommit,
  operation: JournalWriterOperation
): AgentJournalCursor {
  const next = commit.cursor
  if (sameJournalCursor(previous, next) && !commit.inputChanged && commit.items.length === 0) {
    return previous
  }
  const submission = commit.publication?.writtenSubmission
  if (
    commit.publication?.writtenOnly &&
    submission &&
    operation.kind === 'dispatch-written' &&
    previous.epoch === next.epoch &&
    previous.sequence + 1 === next.sequence
  ) {
    const prior = recentReceipts.get(journal)
    const progress = prior ?? {
      epoch: next.epoch,
      after: previous.sequence,
      through: previous.sequence,
      at: 0,
      byId: new Map<string, Receipt>(),
      ordered: []
    }
    const receipt = {
      sequence: next.sequence,
      handoverSequence: operation.handoverCursor.sequence,
      submission
    }
    progress.byId.set(submission.clientMessageId, receipt)
    progress.ordered.push(receipt)
    progress.through = next.sequence
    progress.at = Math.max(progress.at, submission.writtenAt)
    recentReceipts.set(journal, progress)
  } else {
    recentReceipts.delete(journal)
  }
  return { ...next }
}

export function journalStatusCursorIsCurrent(
  journal: SqlAgentSessionJournal,
  read: AgentJournalCursor,
  current: AgentJournalCursor
): boolean {
  if (sameJournalCursor(read, current)) {
    return true
  }
  const receipts = recentReceipts.get(journal)
  return (
    receipts !== undefined &&
    current.sequence === receipts.through &&
    read.epoch === current.epoch &&
    read.sequence >= receipts.after &&
    read.sequence < current.sequence
  )
}

export function journalStatusReceiptProgress(
  journal: SqlAgentSessionJournal
): ReceiptProgress | undefined {
  return recentReceipts.get(journal)
}

/** The cached records and this suffix share a structural baseline. Freeze the upper bound for
 * the capture so a later receipt on the same handle cannot enter a restatement already in flight. */
export function journalReceiptOverlay(journal: SqlAgentSessionJournal, cursor: AgentJournalCursor) {
  const progress = recentReceipts.get(journal)
  if (!progress || progress.epoch !== cursor.epoch || cursor.sequence < progress.after) {
    return (submission: AgentJournalSubmission) => submission
  }
  return (submission: AgentJournalSubmission): AgentJournalSubmission => {
    const receipt = progress.byId.get(submission.clientMessageId)
    return receipt &&
      receipt.sequence <= cursor.sequence &&
      receipt.handoverSequence <= progress.after &&
      submission.writtenAt === undefined &&
      submission.fence === receipt.submission.fence &&
      submission.handedOverAt === receipt.submission.handedOverAt
      ? { ...submission, writtenAt: receipt.submission.writtenAt }
      : submission
  }
}

/** A subscriber that owes structural rows must use durable history. */
export function journalReceiptsAfter(
  journal: SqlAgentSessionJournal,
  cursor: AgentJournalCursor
): readonly Receipt[] | undefined {
  const progress = recentReceipts.get(journal)
  return progress &&
    progress.epoch === cursor.epoch &&
    cursor.sequence >= progress.after &&
    cursor.sequence < progress.through
    ? progress.ordered.slice(cursor.sequence - progress.after)
    : undefined
}

export function advanceJournalStatusActivity<
  T extends AgentJournalCursor & { lastActivityAt: number }
>(
  journal: SqlAgentSessionJournal,
  projection: T,
  cursor: AgentJournalCursor,
  observed?: (projection: T) => void
): T {
  const receipts = recentReceipts.get(journal)
  const result =
    receipts && projection.sequence !== cursor.sequence
      ? {
          ...projection,
          ...cursor,
          lastActivityAt: Math.max(projection.lastActivityAt, receipts.at)
        }
      : projection
  observed?.(result)
  return result
}

export function advanceJournalStatusWork<
  T extends {
    cursor: AgentJournalCursor
    physicalCursor: AgentJournalCursor
  }
>(answer: T, cursor: AgentJournalCursor, physicalCursor: AgentJournalCursor): T {
  return sameJournalCursor(answer.physicalCursor, physicalCursor)
    ? answer
    : { ...answer, cursor, physicalCursor }
}
