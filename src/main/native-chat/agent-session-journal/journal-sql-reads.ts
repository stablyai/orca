import type { JournalRequestMark } from './journal-request-failure'
import type { JournalMailAttempt, JournalMailObservation } from './journal-mail-observation'
import type { JournalRewindCut, JournalRewindSelection } from './journal-domain-rewind-cut'
import type { JournalForkBoundary, JournalSavedContent } from './journal-domain-fork-reads'
import type { AgentSessionConversationOutline } from '../../../shared/agent-session/agent-session-conversation-outline'
import type { JournalStopSettleFact } from './journal-writer-host-facts'
import type { JournalGenerationRead, JournalGenerationResult } from './journal-generation-read'
import type { JournalRewindTarget } from './journal-domain-rewind-target'
import type { JournalObserverRead, JournalObserverResult } from './journal-observer-read'
import type { JournalSqlWorkRead, JournalSqlWorkResult } from './journal-work-read'
import type { AgentSessionJournalReads } from './journal-reads'
import type { JournalSqlPointRead, JournalSqlPointReadResult } from './journal-sql-point-read'
import type { JournalSqlReaderPool } from './journal-sql-reader-pool'
import type { AgentSessionForkedFrom } from '../../../shared/agent-session/lifecycle/agent-session-record'
import type {
  AgentJournalSnapshot,
  AgentJournalRenderItem
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { JournalLatestStop } from './context-epochs/journal-stop-turn-end'
import type { JournalSqlQueueRead, JournalSqlQueueReadResult } from './journal-sql-queued-messages'
import type {
  JournalInputAnswer,
  JournalInputRead,
  JournalInputReader
} from './journal-input-reads'

export type JournalSqlReads = AgentSessionJournalReads & {
  mailObservation(attempt: JournalMailAttempt): Promise<JournalMailObservation>
  itemDetail(itemId: string): Promise<AgentJournalRenderItem | null>
  forkBoundary(
    itemId: string,
    inheritedAnchor: string | undefined,
    compareSubmissions: boolean
  ): Promise<JournalForkBoundary>
  savedContent(): Promise<JournalSavedContent>
  conversationOutline(budgetBytes: number): Promise<AgentSessionConversationOutline>
  requestFailure(kind: JournalRequestMark['kind'], id: string): Promise<AgentJournalSnapshot>
  runningRequest(stopSettle?: JournalStopSettleFact): Promise<JournalRequestMark | null>
  rewindTarget(itemId: string): Promise<JournalRewindTarget>
  rewindCut(target: JournalRewindSelection): Promise<JournalRewindCut | null>
  namingPrompt(hostStartedAt?: number): Promise<string>
  automationRun(messageId: string, inputIds: readonly string[]): Promise<AgentJournalSnapshot>
  historySourceItems(clientMessageIds: readonly string[]): Promise<AgentJournalRenderItem[]>
  hasProviderTurn(nativeId: string): Promise<boolean>
  savedItemIds(itemIds: readonly string[]): Promise<string[]>
  forkMarkerGroup(
    boundary: AgentSessionForkedFrom['childBoundary'],
    previousSequence?: number
  ): Promise<AgentJournalSnapshot>
  projectedStopNotes(
    afterOrdinal?: number,
    limit?: number
  ): Promise<{
    items: AgentJournalRenderItem[]
    nextOrdinal: number | null
  }>
  generation(input?: JournalGenerationRead): Promise<JournalGenerationResult>
  observer(input: JournalObserverRead): Promise<JournalObserverResult>
  work(input: JournalSqlWorkRead): Promise<JournalSqlWorkResult>
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
    mailObservation: async (attempt) =>
      (await read({ kind: 'mail-observation', attempt })).observation,
    forkBoundary: async (itemId, inheritedAnchor, compareSubmissions) =>
      (await read({ kind: 'fork-boundary', itemId, inheritedAnchor, compareSubmissions })).boundary,
    savedContent: async () => (await read({ kind: 'saved-content' })).content,
    conversationOutline: async (budgetBytes) =>
      (await read({ kind: 'conversation-outline', budgetBytes })).outline,
    requestFailure: async (requestKind, id) =>
      (await read({ kind: 'request-failure', requestKind, id })).snapshot,
    runningRequest: async (stopSettle) =>
      (await read({ kind: 'running-request', stopSettle })).request,
    rewindTarget: async (itemId) => (await read({ kind: 'rewind-target', itemId })).target,
    rewindCut: async (target) => (await read({ kind: 'rewind-cut', target })).cut,
    namingPrompt: async (hostStartedAt) =>
      (await read({ kind: 'naming-prompt', hostStartedAt })).prompt,
    automationRun: async (messageId, inputIds) =>
      (await read({ kind: 'automation-run', messageId, inputIds })).snapshot,
    historySourceItems: async (clientMessageIds) => {
      const items: AgentJournalRenderItem[] = []
      for (let offset = 0; offset < clientMessageIds.length; offset += 128) {
        items.push(
          ...(
            await read({
              kind: 'history-source-items',
              clientMessageIds: clientMessageIds.slice(offset, offset + 128)
            })
          ).items
        )
      }
      return items
    },
    hasProviderTurn: async (namespace) =>
      (await read({ kind: 'provider-turn-in-namespace', namespace })).present,
    savedItemIds: async (itemIds) => (await read({ kind: 'saved-item-ids', itemIds })).itemIds,
    forkMarkerGroup: async (boundary, previousSequence) =>
      (await read({ kind: 'fork-marker-group', boundary, previousSequence })).snapshot,
    projectedStopNotes: async (afterOrdinal = -1, limit = 128) =>
      read({ kind: 'projected-stop-notes', afterOrdinal, limit }),
    generation: async (input = {}) => (await read({ kind: 'generation', input })).generation,
    work: async (input) => (await read({ kind: 'work', input })).answer,
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
    namedTurn: async (turnId) => (await read({ kind: 'named-turn', turnId })).turn,
    messageOptions: async (clientMessageId) =>
      (await read({ kind: 'message-options', clientMessageId })).options,
    continuationContext: async () => (await read({ kind: 'continuation-context' })).context,
    latestPrompt: async () => (await read({ kind: 'latest-prompt' })).prompt,
    restartProgress: async (cursor) => (await read({ kind: 'restart-progress', cursor })).progress,
    outgrownChild: async (input) => (await read({ kind: 'outgrown-child', input })).child,
    contextFloor: async () => (await read({ kind: 'context-floor' })).floor,
    cursor: async () => (await metadata()).cursor,
    physicalCursor: async () => (await metadata()).physicalCursor,
    lastActivityAt: async () => (await metadata()).lastActivityAt,
    historyOrigin: async () => (await metadata()).historyOrigin,
    item,
    itemDetail: async (itemId) => (await read({ kind: 'item-detail', itemId })).item,
    itemBody: async (itemId) => (await item(itemId))?.body ?? null,
    itemFence: async (itemId) => {
      const { executionOwner, ownerFence } = await provenance(itemId)
      return executionOwner ?? ownerFence
    },
    itemProvenance: provenance,
    hasRecordedItem: async (itemId) => (await read({ kind: 'has-recorded-item', itemId })).recorded,
    hasItems: async () => (await read({ kind: 'has-items' })).hasItems,
    presentationRemoved: async (itemId) =>
      (await read({ kind: 'presentation-removed', itemId })).removed,
    canonicalItemId: async (itemId) => (await read({ kind: 'canonical-item-id', itemId })).itemId,
    canonicalItemIds: async (itemIds) =>
      (await read({ kind: 'canonical-item-ids', itemIds })).items,
    historyItems: async (itemIds, options) =>
      (await read({ kind: 'history-items', itemIds, options })).items,
    claudeHistoryPrompts: async (sessionId, uuids) =>
      (await read({ kind: 'claude-history-prompts', sessionId, uuids })).prompts,
    submission: async (clientMessageId) =>
      (await read({ kind: 'submission', clientMessageId })).submission,
    submissionBody: async (clientMessageId) =>
      (await read({ kind: 'submission-body', clientMessageId })).body,
    receiptFor: async (clientMessageId) =>
      (await read({ kind: 'acceptance', clientMessageId })).receipt,
    lastProviderActivityAt: async (fence) => (await read({ kind: 'provider-activity', fence })).at,
    runningTurn: async () => (await read({ kind: 'running-turn' })).running,
    threadGoalSource: async () => (await read({ kind: 'thread-goal-source' })).source,
    claudeSnapshot: async () => (await read({ kind: 'claude-snapshot' })).snapshot,
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
          visit(entry.itemId, entry.sequence, entry.body, entry, entry)
        }
        if (page.nextOrdinal === null) {
          return
        }
        afterOrdinal = page.nextOrdinal
      }
    }
  }
}
