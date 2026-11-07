import type {
  AgentJournalRenderItem,
  AgentJournalSubmission,
  AgentJournalTurnLifecycle
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { JournalReducerState } from './projection/journal-reducer'
import type { JournalInputCard, JournalInputEntry } from './input-order/journal-input-lineage'
import type { QueuedMessageRow } from './queued-messages/queued-message-table'
import type { JournalStatusItem, JournalStatusItemSelection } from './journal-status-items'

/** Each live range query names its population; whole-state restore/export remains memory-only. */
export type JournalStateQueries = {
  hasStatusRequestItem: (state: JournalReducerState) => boolean
  failedStatusItems: (state: JournalReducerState, floor: number) => Iterable<JournalStatusItem>
  statusItems: (
    state: JournalReducerState,
    selection: JournalStatusItemSelection
  ) => Iterable<JournalStatusItem>
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
  oldestAppliedSettlementId: (state: JournalReducerState) => string | undefined
  nativeInputEntries: (state: JournalReducerState) => Iterable<[string, JournalInputEntry]>
  nativeInputCards: (state: JournalReducerState) => Iterable<[string, JournalInputCard]>
  queueCardsForInitialization: (state: JournalReducerState) => Iterable<QueuedMessageRow>
}
