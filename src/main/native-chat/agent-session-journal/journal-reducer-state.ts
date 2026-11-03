import { initializeJournalInputOrder, type JournalInputOrder } from './journal-input-order'
import type { JournalInputEntry, JournalInputCard } from './journal-input-lineage'
import type {
  AgentJournalAcceptanceReceipt,
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { JournalHistoryOrigin } from './journal-history-origin'
import { JournalDerivedTurnScope } from './journal-derived-turn-scope'
import { createJournalQueuePauseMarks, type JournalQueuePauseMarks } from './queued-message-pause'
import { createJournalQueueState, type JournalQueueState } from './journal-queue-fold'

export type JournalReducerState = {
  sessionId: string
  epoch: string
  lastSequence: number
  lastActivityAt: number
  /** Earliest individually replayable sequence. */
  oldestSequence: number
  highestFence: number
  items: Map<string, AgentJournalRenderItem>
  /** Creation provenance determines whether an item belongs to current execution. */
  itemFences: Map<string, number>
  /** Later runs may explicitly assume execution of reusable child items. */
  itemExecutionOwners: Map<string, number>
  providerActivityAt: Map<number, number>
  /** Retain removed revisions to prevent stale resurrection. */
  tombstones: Map<string, number>
  /** Rewound turns remain ended even after their visible records disappear. */
  removedTurnIds: Set<string>
  submissions: Map<string, AgentJournalSubmission>
  receipts: Map<string, AgentJournalAcceptanceReceipt>
  /** Alias provider echoes to existing optimistic submissions to prevent duplicate bubbles. */
  aliases: Map<string, string>
  /** Preserve the first declared echo contract through tombstones. */
  itemEchoes: Map<string, unknown>
  appliedSettlementIds: Set<string>
  derivedTurnScope: JournalDerivedTurnScope
  /** Acceptance survives visible-message rewind; zero means none in this epoch. */
  latestAcceptedTurnSequence: number
  queuePauseMarks: JournalQueuePauseMarks
  stoppedHistoryCarried: Map<string, readonly string[]>
  queuedHandOffPlaces: Map<
    string,
    Pick<AgentJournalRenderItem, 'sequence' | 'observedAt' | 'turnScope'>
  >
  /** Historical display corrections, rebuilt by the hand-off fold on replay. */
  normalizedHandOffs: Set<string>
  /** The queued messages, folded from their own rows and their hand-offs (`journal-queue-fold.ts`). */
  queue: JournalQueueState
  inputEntries: Map<string, JournalInputEntry>
  inputCards: Map<string, JournalInputCard>
  historyOrigin: JournalHistoryOrigin | null
}

export function createJournalReducerState(
  sessionId: string,
  epoch: string,
  originalAcceptance?: ConstructorParameters<typeof JournalInputOrder>[1]
): JournalReducerState {
  const state: JournalReducerState = {
    sessionId,
    epoch,
    lastSequence: 0,
    lastActivityAt: 0,
    oldestSequence: 1,
    highestFence: 0,
    items: new Map(),
    itemFences: new Map(),
    itemExecutionOwners: new Map(),
    providerActivityAt: new Map(),
    tombstones: new Map(),
    removedTurnIds: new Set(),
    submissions: new Map(),
    receipts: new Map(),
    aliases: new Map(),
    itemEchoes: new Map(),
    appliedSettlementIds: new Set(),
    derivedTurnScope: new JournalDerivedTurnScope(),
    latestAcceptedTurnSequence: 0,
    queuePauseMarks: createJournalQueuePauseMarks(),
    stoppedHistoryCarried: new Map(),
    queuedHandOffPlaces: new Map(),
    normalizedHandOffs: new Set(),
    queue: createJournalQueueState(),
    inputEntries: new Map(),
    inputCards: new Map(),
    historyOrigin: null
  }
  initializeJournalInputOrder(state, originalAcceptance)
  return state
}
