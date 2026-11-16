import type {
  AgentJournalRenderItem,
  AgentJournalSubmission,
  AgentJournalTurnLifecycle
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { JournalReducerState } from './projection/journal-reducer'
import type { JournalInputCard, JournalInputEntry } from './input-order/journal-input-lineage'
import type { QueuedMessageRow } from './queued-messages/queued-message-table'
import type { UsageLimitContinueIdentity } from '../../../shared/agent-session/lifecycle/stopping/agent-session-usage-limit-continue'

/** Each live range query names its population; whole-state restore/export remains memory-only. */
export type JournalStateQueries = {
  usageLimitContinueIdentity: (state: JournalReducerState) => UsageLimitContinueIdentity | undefined
  latestContextClearSequence: (state: JournalReducerState) => number
  echoClaimant: (state: JournalReducerState, fingerprint: string, marker5: boolean) => string | null
  itemsAfterSequence: (
    state: JournalReducerState,
    sequence: number
  ) => Iterable<AgentJournalRenderItem>
  aliasesForSubmission: (state: JournalReducerState, itemId: string) => Iterable<string>
  candidatesForFence: (state: JournalReducerState, fence: number) => AgentJournalSubmission[]
  candidatesForHandoverFence: (
    state: JournalReducerState,
    fence: number
  ) => Iterable<AgentJournalSubmission>
  returnedCommandIds: (state: JournalReducerState) => Iterable<string>
  latestAcceptedUnopened: (state: JournalReducerState) => boolean
  newestTurnBySequence: (state: JournalReducerState) => AgentJournalTurnLifecycle | null
  latestItemForTurn: (state: JournalReducerState, turnId: string) => AgentJournalRenderItem | null
  newestTurnItem: (state: JournalReducerState) => AgentJournalRenderItem | null
  /** Visible items whose key starts with this prefix, in insertion order. */
  itemsWithKeyPrefix: (
    state: JournalReducerState,
    prefix: string
  ) => Iterable<AgentJournalRenderItem>
  /** The most recently written visible item whose key starts with this prefix. */
  newestItemWithKeyPrefix: (
    state: JournalReducerState,
    prefix: string
  ) => AgentJournalRenderItem | null
  contextWindowHeld: (state: JournalReducerState) => boolean
  /** Running turns and calls, pending prompts and live work; null spans every turn. */
  unsettledItems: (
    state: JournalReducerState,
    turnItemId: string | null
  ) => Iterable<AgentJournalRenderItem>
  oldestAppliedSettlementId: (state: JournalReducerState) => string | undefined
  nativeInputEntries: (state: JournalReducerState) => Iterable<[string, JournalInputEntry]>
  nativeInputCards: (state: JournalReducerState) => Iterable<[string, JournalInputCard]>
  queueCardsForInitialization: (state: JournalReducerState) => Iterable<QueuedMessageRow>
}
