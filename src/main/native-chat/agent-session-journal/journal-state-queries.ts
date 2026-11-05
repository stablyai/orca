import type {
  AgentJournalRenderItem,
  AgentJournalSubmission,
  AgentJournalTurnLifecycle
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { JournalReducerState } from './journal-reducer'
import type { JournalInputCard, JournalInputEntry } from './journal-input-lineage'
import type { QueuedMessageRow } from './queued-message-table'

/** Each live range query names its population; whole-state restore/export remains memory-only. */
export type JournalStateQueries = {
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
  legacyInputEntryCount: (state: JournalReducerState) => number
  latestAcceptedUnopened: (state: JournalReducerState) => boolean
  newestTurnBySequence: (state: JournalReducerState) => AgentJournalTurnLifecycle | null
  oldestAppliedSettlementId: (state: JournalReducerState) => string | undefined
  nativeInputEntries: (state: JournalReducerState) => Iterable<[string, JournalInputEntry]>
  nativeInputCards: (state: JournalReducerState) => Iterable<[string, JournalInputCard]>
  queueCardsForInitialization: (state: JournalReducerState) => Iterable<QueuedMessageRow>
}
