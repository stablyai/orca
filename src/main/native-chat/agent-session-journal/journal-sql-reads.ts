import type { AgentSessionJournalReads } from './journal-reads'
import type { JournalSqlPointRead, JournalSqlPointReadResult } from './journal-sql-point-read'
import type { JournalSqlReaderPool } from './journal-sql-reader-pool'

/** Input-order reads move here with the single-list queue; until then the fold answers them. */
export type JournalSqlReads = Omit<AgentSessionJournalReads, 'pendingSubmissions' | 'newestTurn'>

const VISIT_PAGE = 256

type PointKind = JournalSqlPointReadResult['kind']

function answered<K extends PointKind>(
  result: JournalSqlPointReadResult,
  kind: K
): result is Extract<JournalSqlPointReadResult, { kind: K }> {
  return result.kind === kind
}

/** Each read is one WAL snapshot on a reader worker; nothing about the chat is retained here. */
export function journalSqlReads(
  readers: Pick<JournalSqlReaderPool, 'point'>,
  sessionId: string
): JournalSqlReads {
  const read = async <K extends PointKind>(
    operation: JournalSqlPointRead['operation'] & { kind: K }
  ): Promise<Extract<JournalSqlPointReadResult, { kind: K }>> => {
    const result = await readers.point({ sessionId, operation })
    if (!answered(result, operation.kind)) {
      throw new Error(`journal reader answered ${result.kind} for ${operation.kind}`)
    }
    return result
  }
  const metadata = () => read({ kind: 'metadata' })
  const item = async (itemId: string) => (await read({ kind: 'item', itemId })).item
  const provenance = async (itemId: string) =>
    (await read({ kind: 'item-provenance', itemId })).provenance
  return {
    contextFloor: async () => (await read({ kind: 'context-floor' })).floor,
    cursor: async () => (await metadata()).cursor,
    physicalCursor: async () => (await metadata()).physicalCursor,
    lastActivityAt: async () => (await metadata()).lastActivityAt,
    historyOrigin: async () => (await metadata()).historyOrigin,
    item,
    itemBody: async (itemId) => (await item(itemId))?.body ?? null,
    itemFence: async (itemId) => {
      const { executionOwner, ownerFence } = await provenance(itemId)
      return executionOwner ?? ownerFence
    },
    itemProvenance: provenance,
    hasRecordedItem: async (itemId) => (await read({ kind: 'has-recorded-item', itemId })).recorded,
    presentationRemoved: async (itemId) =>
      (await read({ kind: 'presentation-removed', itemId })).removed,
    canonicalItemId: async (itemId) => (await read({ kind: 'canonical-item-id', itemId })).itemId,
    submission: async (clientMessageId) =>
      (await read({ kind: 'submission', clientMessageId })).submission,
    submissionBody: async (clientMessageId) =>
      (await read({ kind: 'submission-body', clientMessageId })).body,
    receiptFor: async (clientMessageId) =>
      (await read({ kind: 'acceptance', clientMessageId })).receipt,
    lastProviderActivityAt: async (fence) => (await read({ kind: 'provider-activity', fence })).at,
    runningTurn: async () => (await read({ kind: 'running-turn' })).running,
    threadGoalSource: async () => (await read({ kind: 'thread-goal-source' })).source,
    contextUsage: async () => (await read({ kind: 'context-usage' })).usage,
    visitItems: async (filter, visit) => {
      let afterOrdinal = -1
      for (;;) {
        const page = await read({
          kind: 'items-by-kind',
          kinds: filter.kinds,
          afterOrdinal,
          limit: VISIT_PAGE
        })
        for (const entry of page.items) {
          visit(entry.itemId, entry.sequence, entry.body, entry)
        }
        if (page.nextOrdinal === null) {
          return
        }
        afterOrdinal = page.nextOrdinal
      }
    }
  }
}
