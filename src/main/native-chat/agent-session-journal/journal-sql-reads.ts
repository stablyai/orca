import type { JournalObserverRead, JournalObserverResult } from './journal-observer-read'
import type { AgentSessionJournalReads } from './journal-reads'
import type { JournalSqlPointRead, JournalSqlPointReadResult } from './journal-sql-point-read'
import type { JournalSqlReaderPool } from './journal-sql-reader-pool'
import type { JournalLatestStop } from './context-epochs/journal-stop-turn-end'
import type { JournalSqlQueueRead, JournalSqlQueueReadResult } from './journal-sql-queued-messages'
import type {
  JournalInputAnswer,
  JournalInputRead,
  JournalInputReader
} from './journal-input-reads'

export type JournalSqlReads = AgentSessionJournalReads & {
  observer(input: JournalObserverRead): Promise<JournalObserverResult>
  /** The saved latest Stop, without the host's settlement overlay. */
  latestStop(): Promise<JournalLatestStop | null>
  latestAcceptedSendUnopened(): Promise<boolean>
  turnWasRemoved(turnId: string): Promise<boolean>
  queue(operation: JournalSqlQueueRead): Promise<JournalSqlQueueReadResult>
}

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
  const input: JournalInputReader = async <K extends JournalInputRead['kind']>(
    operation: Extract<JournalInputRead, { kind: K }>
  ) => {
    const { result } = await read({ kind: 'input-read', operation })
    if (result.kind !== operation.kind) {
      throw new Error(`journal input reader answered ${result.kind} for ${operation.kind}`)
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the named procedure returns its matching discriminant, checked above.
    return result as JournalInputAnswer<K>
  }
  const item = async (itemId: string) => (await read({ kind: 'item', itemId })).item
  const provenance = async (itemId: string) =>
    (await read({ kind: 'item-provenance', itemId })).provenance
  return {
    observer: async (input) => (await read({ kind: 'observer', input })).observation,
    latestStop: async () => (await read({ kind: 'latest-stop' })).stop,
    latestAcceptedSendUnopened: async () =>
      (await read({ kind: 'accepted-send-unopened' })).unopened,
    turnWasRemoved: async (turnId) => (await read({ kind: 'turn-removed', turnId })).removed,
    queue: async (operation) => (await read({ kind: 'queue', operation })).result,
    statusIndicators: async (input) =>
      (await read({ kind: 'status-indicators', input })).indicators,
    statusState: async (currentFence) =>
      (await read({ kind: 'status-state', currentFence })).status,
    input,
    usageLimitCut: async () => (await read({ kind: 'usage-limit-cut' })).cut,
    orcaStopCut: async () => (await read({ kind: 'orca-stop-cut' })).cut,
    pendingSubmissions: async () => (await input({ kind: 'pending-submissions' })).submissions,
    newestTurn: async () => (await input({ kind: 'newest-turn' })).turn,
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
