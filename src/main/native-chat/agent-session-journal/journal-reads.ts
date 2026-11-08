import type {
  AgentJournalAcceptanceReceipt,
  AgentJournalItemBody,
  AgentJournalMessageItem,
  AgentJournalRenderItem,
  AgentJournalSubmission,
  AgentJournalSnapshot,
  AgentJournalTurnLifecycle
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentSessionContextUsage } from '../../../shared/agent-session/agent-session-context-usage'
import type { JournalItemLinkageVisitor } from './journal-store-contracts'
import type { JournalReducerState } from './projection/journal-reducer'
import type { JournalItemEcho } from './projection/journal-item-echo'
import type { JournalThreadGoalSource } from './projection/journal-thread-goal-source'
import { readJournalInput, type JournalInputReader } from './journal-input-reads'
import { readJournalUsageLimitCut, readJournalOrcaStopCut } from './journal-status-cuts'
import type { NativeChatUsageLimitCut } from '../../../shared/native-chat/native-chat-usage-limit-cut'
import { readJournalStatusState, type JournalStatusState } from './journal-status-state'
import type { NativeChatOrcaStopCut } from '../../../shared/native-chat/native-chat-orca-stop-cut'
import type { AgentJournalTurnScope } from '../../../shared/agent-session/journal/agent-session-journal-turn-scope'
import { memoryJournalMap } from './journal-memory-collections'
import { journalInputPresentationMember } from './input-order/journal-input-obligations'
import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { agentSessionCurrentContextRows } from '../../../shared/agent-session/agent-session-context-clear'
import {
  readJournalStatusIndicators,
  type JournalStatusIndicatorRead,
  type JournalStatusIndicators
} from './journal-status-indicators'

/** Which items a visit decodes; a database serves only the named kinds, in sequence order. */
export type JournalItemFilter = {
  kinds: readonly AgentJournalItemBody['kind'][]
}

export type JournalNamedTurn = {
  scope: Extract<AgentJournalTurnScope, { kind: 'turn' }> | null
  removed: boolean
}

export type JournalMessageOptions = { ordinaryMessage: boolean; runningTurn: boolean }

export type JournalContinuationContext = {
  cursor: AgentJournalCursor
  items: readonly AgentJournalRenderItem[]
  submissions: readonly AgentJournalSubmission[]
}

/** Reads a chat answers from its database; scans are filtered so none decodes the whole chat. */
export type AgentSessionJournalReads = {
  statusIndicators(input: JournalStatusIndicatorRead): Promise<JournalStatusIndicators>
  statusState(currentFence?: number | null): Promise<JournalStatusState>
  input: JournalInputReader
  usageLimitCut(): Promise<NativeChatUsageLimitCut | null>
  orcaStopCut(): Promise<NativeChatOrcaStopCut | null>
  // Builder B: context metadata used by options reports.
  contextFloor(): Promise<AgentJournalCursor | null>
  cursor(): Promise<AgentJournalCursor>
  physicalCursor(): Promise<AgentJournalCursor>
  lastActivityAt(): Promise<number>
  historyOrigin(): Promise<JournalReducerState['historyOrigin']>
  item(itemId: string): Promise<AgentJournalRenderItem | null>
  itemBody(itemId: string): Promise<AgentJournalItemBody | null>
  itemFence(itemId: string): Promise<number | undefined>
  itemProvenance(
    itemId: string
  ): Promise<JournalItemEcho & { ownerFence?: number; executionOwner?: number }>
  hasRecordedItem(itemId: string): Promise<boolean>
  hasItems(): Promise<boolean>
  presentationRemoved(itemId: string): Promise<boolean>
  canonicalItemId(itemId: string): Promise<string>
  canonicalItemIds(
    itemIds: readonly string[]
  ): Promise<readonly { itemId: string; canonicalItemId: string }[]>
  submission(clientMessageId: string): Promise<AgentJournalSubmission | undefined>
  submissionBody(clientMessageId: string): Promise<AgentJournalMessageItem | null>
  receiptFor(clientMessageId: string): Promise<AgentJournalAcceptanceReceipt | null>
  pendingSubmissions(): Promise<AgentJournalSubmission[]>
  lastProviderActivityAt(fence: number): Promise<number | undefined>
  runningTurn(): Promise<{ item: AgentJournalRenderItem; turnId: string } | null>
  newestTurn(): Promise<AgentJournalTurnLifecycle | null>
  namedTurn(turnId: string): Promise<JournalNamedTurn>
  messageOptions(clientMessageId: string): Promise<JournalMessageOptions>
  continuationContext(): Promise<JournalContinuationContext>
  threadGoalSource(): Promise<JournalThreadGoalSource>
  contextUsage(): Promise<AgentSessionContextUsage>
  visitItems(filter: JournalItemFilter, visit: JournalItemLinkageVisitor): Promise<void>
}

/** The synchronous readers today's in-memory journal already answers. */
type FoldedJournalReads = {
  [
    K in Exclude<
      keyof AgentSessionJournalReads,
      | 'visitItems'
      | 'hasItems'
      | 'canonicalItemIds'
      | 'namedTurn'
      | 'messageOptions'
      | 'continuationContext'
      | 'contextFloor'
      | 'input'
      | 'usageLimitCut'
      | 'orcaStopCut'
      | 'statusState'
      | 'statusIndicators'
    >
  ]: (
    ...args: Parameters<AgentSessionJournalReads[K]>
  ) => Awaited<ReturnType<AgentSessionJournalReads[K]>>
} & {
  snapshot(): AgentJournalSnapshot
  visitItemsWithLinkage(visit: JournalItemLinkageVisitor): void
  // Builder B: context metadata stays fold-backed until the database reader replaces it.
  context: { floor(): AgentJournalCursor | null }
}

/** Answers at call time, so an awaited answer reflects writes admitted before the call. */
export function foldedJournalReads(
  journal: FoldedJournalReads,
  state: () => JournalReducerState
): AgentSessionJournalReads {
  const now =
    <A extends unknown[], T>(read: (...args: A) => T) =>
    (...args: A): Promise<T> => {
      try {
        return Promise.resolve(read(...args))
      } catch (error) {
        return Promise.reject(error)
      }
    }
  return {
    statusIndicators: now((input: JournalStatusIndicatorRead) =>
      readJournalStatusIndicators(state(), input)
    ),
    statusState: now((fence?: number | null) => readJournalStatusState(state(), fence)),
    input: async (operation) => readJournalInput(state(), operation),
    usageLimitCut: now(() => readJournalUsageLimitCut(state())),
    orcaStopCut: now(() => readJournalOrcaStopCut(state())),
    // Builder B: read through the context controller without retaining a copy.
    contextFloor: now(() => journal.context.floor()),
    cursor: now(journal.cursor),
    physicalCursor: now(journal.physicalCursor),
    lastActivityAt: now(journal.lastActivityAt),
    historyOrigin: now(journal.historyOrigin),
    item: now(journal.item),
    itemBody: now(journal.itemBody),
    itemFence: now(journal.itemFence),
    itemProvenance: now(journal.itemProvenance),
    hasRecordedItem: now(journal.hasRecordedItem),
    hasItems: now(() => {
      const current = state()
      for (const item of memoryJournalMap(current.items).values()) {
        if (journalInputPresentationMember(current, item.itemId)) {
          return true
        }
      }
      return false
    }),
    presentationRemoved: now(journal.presentationRemoved),
    canonicalItemId: now(journal.canonicalItemId),
    canonicalItemIds: now((itemIds: readonly string[]) =>
      itemIds.map((itemId) => ({ itemId, canonicalItemId: journal.canonicalItemId(itemId) }))
    ),
    submission: now(journal.submission),
    submissionBody: now(journal.submissionBody),
    receiptFor: now(journal.receiptFor),
    pendingSubmissions: now(journal.pendingSubmissions),
    lastProviderActivityAt: now(journal.lastProviderActivityAt),
    runningTurn: now(journal.runningTurn),
    newestTurn: now(journal.newestTurn),
    namedTurn: now((turnId: string) => {
      const current = state()
      const item = current.queries.latestItemForTurn(current, turnId)
      return {
        scope: item ? { kind: 'turn' as const, turnItemId: item.itemId } : null,
        removed: current.removedTurnIds.has(turnId)
      }
    }),
    messageOptions: now((clientMessageId: string) => {
      const body = journal.itemBody(agentJournalSubmissionKey(clientMessageId))
      return {
        ordinaryMessage: body?.kind === 'message' && !body.command,
        runningTurn: journal.newestTurn()?.state === 'running'
      }
    }),
    continuationContext: now(() => {
      const snapshot = journal.snapshot()
      return {
        cursor: snapshot.cursor,
        ...agentSessionCurrentContextRows(snapshot.items, snapshot.submissions)
      }
    }),
    threadGoalSource: now(journal.threadGoalSource),
    contextUsage: now(journal.contextUsage),
    visitItems: now((filter: JournalItemFilter, visit: JournalItemLinkageVisitor) => {
      const kinds = new Set(filter.kinds)
      journal.visitItemsWithLinkage((itemId, sequence, body, attribution, item) => {
        if (kinds.has(body.kind)) {
          visit(itemId, sequence, body, attribution, item)
        }
      })
    })
  }
}
