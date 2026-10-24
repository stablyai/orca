import {
  newestStructuredAgentSessionTurnBySequence,
  runningStructuredAgentSessionTurnItemBySequence
} from '../../../shared/structured-agent-session-live-turn'
import { journalItemExecutionFence, journalItemProvenance } from './journal-item-provenance'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem,
  AgentJournalTurnLifecycle
} from '../../../shared/agent-session-journal-types'
import type { JournalItemLinkageVisitor } from './journal-store-contracts'
import type { JournalReducerState } from './journal-reducer'
import { journalHasUnwitnessedText } from './journal-text-query'

export function createJournalItemReaders(state: () => JournalReducerState) {
  return {
    /** Read the journal's running turn without allocating a snapshot; host projection decides current work. */
    runningTurn: (): { item: AgentJournalRenderItem; turnId: string } | null =>
      runningStructuredAgentSessionTurnItemBySequence(state().items.values()),

    newestTurn: (): AgentJournalTurnLifecycle | null =>
      newestStructuredAgentSessionTurnBySequence(state().items.values()),

    /** Whose execution the item is now, while it is in the timeline: the run a reusable child's row
     *  last named (`JournalItemRow.executionOwner`), else its creator (`JournalItemRow.ownerFence`). */
    itemFence: (itemId: string): number | undefined => journalItemExecutionFence(state(), itemId),

    /** Both provenance facts as stored, for a rebuild that writes them again. */
    itemProvenance: (itemId: string) => journalItemProvenance(state(), itemId),

    /** Latest saved output at this fence, excluding client actions and recovery bookkeeping. */
    lastProviderActivityAt: (fence: number) => state().providerActivityAt.get(fence),

    /** Visits reduced items without allocating and sorting a full snapshot. */
    visitItems: (
      visit: (itemId: string, sequence: number, body: AgentJournalItemBody) => void
    ): void => {
      for (const item of state().items.values()) {
        visit(item.itemId, item.sequence, item.body)
      }
    },

    /** One reduced item's body by its journal key, for a writer revising a row it can name. */
    itemBody: (itemId: string): AgentJournalItemBody | null =>
      state().items.get(itemId)?.body ?? null,

    /** Authority still owed by suffixes newer than their last saved whole. */
    hasUnwitnessedText: (itemId: string): boolean => {
      return journalHasUnwitnessedText(state(), itemId)
    },

    /** Host-only: the stopped messages each handed-over send carried, by its client message id. */
    stoppedHistoryCarried: (): ReadonlyMap<string, readonly string[]> =>
      state().stoppedHistoryCarried,

    /** One reduced item with its attribution, for a writer that needs the turn a row joined. */
    textSource: (itemId: string) => state().textPolicy.get(itemId),
    textSourceByRaw: (key: string) => state().textPolicy.raw.get(key),
    textSources: () => state().textPolicy.values(),
    retireText: (itemId: string): void => {
      state().textPolicy.delete(itemId)
    },

    item: (itemId: string): AgentJournalRenderItem | null => state().items.get(itemId) ?? null,

    /** Visits reduced items with the producer that wrote each, for a producer re-deriving what an
     *  earlier run of this session left. */
    visitItemsWithLinkage: (visit: JournalItemLinkageVisitor): void => {
      for (const item of state().items.values()) {
        visit(item.itemId, item.sequence, item.body, item)
      }
    }
  }
}
