import type {
  AgentJournalAcceptanceReceipt,
  AgentJournalSubmission,
  AgentJournalItemBody,
  AgentJournalRenderItem,
  AgentJournalTurnLifecycle
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionContextUsage } from '../../../shared/agent-session-context-usage'
import { latestStructuredAgentContextFacts } from '../../../shared/structured-agent-session-context-usage'
import {
  newestStructuredAgentSessionTurnBySequence,
  runningStructuredAgentSessionTurnItemBySequence
} from '../../../shared/structured-agent-session-live-turn'
import type { JournalReducerState } from './journal-reducer'
import type { JournalItemLinkageVisitor } from './journal-store-contracts'
import { journalItemExecutionFence, journalItemProvenance } from './journal-item-provenance'
import { journalThreadGoalSource, type JournalThreadGoalSource } from './journal-thread-goal-source'

export function createJournalItemReads(state: () => JournalReducerState) {
  /** Visit without allocating/sorting a snapshot. */
  const visitItems = (
    visit: (itemId: string, sequence: number, body: AgentJournalItemBody) => void
  ): void => {
    for (const item of state().items.values()) {
      visit(item.itemId, item.sequence, item.body)
    }
  }

  const itemBody = (itemId: string): AgentJournalItemBody | null =>
    state().items.get(itemId)?.body ?? null

  /** Host-only stopped-history IDs carried by each send. */
  const stoppedHistoryCarried = (): ReadonlyMap<string, readonly string[]> =>
    state().stoppedHistoryCarried

  const item = (itemId: string): AgentJournalRenderItem | null => state().items.get(itemId) ?? null

  const visitItemsWithLinkage = (visit: JournalItemLinkageVisitor): void => {
    for (const item of state().items.values()) {
      visit(item.itemId, item.sequence, item.body, item)
    }
  }

  /** Read the journal's running turn without allocating a snapshot; host projection decides current work. */
  const runningTurn = (): { item: AgentJournalRenderItem; turnId: string } | null =>
    runningStructuredAgentSessionTurnItemBySequence(state().items.values())

  const newestTurn = (): AgentJournalTurnLifecycle | null =>
    newestStructuredAgentSessionTurnBySequence(state().items.values())

  const threadGoalSource = (): JournalThreadGoalSource =>
    journalThreadGoalSource(state().items.values())

  /** Read across the journal, beyond any client's loaded page. */
  const contextUsage = (): AgentSessionContextUsage =>
    latestStructuredAgentContextFacts(state().items.values())

  /** Prefer later execution ownership for reusable children, otherwise creation provenance. */
  const itemFence = (itemId: string): number | undefined =>
    journalItemExecutionFence(state(), itemId)

  /** Preserve both provenance fields during rebuild. */
  const itemProvenance = (itemId: string) => journalItemProvenance(state(), itemId)

  const submissions = (): AgentJournalSubmission[] => [...state().submissions.values()]

  const historyOrigin = () => state().historyOrigin

  const submission = (clientMessageId: string) => state().submissions.get(clientMessageId)

  /** Reconnecting clients read durable acceptance instead of resending. */
  const receiptFor = (clientMessageId: string): AgentJournalAcceptanceReceipt | null =>
    state().receipts.get(clientMessageId) ?? null

  return {
    submissions,
    historyOrigin,
    submission,
    receiptFor,
    visitItems,
    itemBody,
    stoppedHistoryCarried,
    item,
    visitItemsWithLinkage,
    runningTurn,
    newestTurn,
    threadGoalSource,
    contextUsage,
    itemFence,
    itemProvenance
  }
}
