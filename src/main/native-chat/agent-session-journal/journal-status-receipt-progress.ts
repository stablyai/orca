import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import { sameJournalCursor } from './replay/journal-cursor'
import type { SqlAgentSessionJournal } from './journal-sql-store'
import type { JournalWriterCommit } from './journal-writer-changes'
import type { JournalWriterOperation } from './journal-writer-command'

type ReceiptProgress = { after: number; through: number; at: number }
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
  if (
    commit.publication?.writtenOnly &&
    operation.kind === 'dispatch-written' &&
    previous.epoch === next.epoch &&
    previous.sequence + 1 === next.sequence
  ) {
    const prior = recentReceipts.get(journal)
    recentReceipts.set(journal, {
      after: prior?.after ?? previous.sequence,
      through: next.sequence,
      at: Math.max(prior?.at ?? 0, operation.observedAt)
    })
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
