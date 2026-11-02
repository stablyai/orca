import type {
  AgentJournalItemBody,
  AgentJournalRenderItem,
  AgentJournalTurnLifecycle
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionContextUsage } from '../../../shared/agent-session/agent-session-context-usage'
import { latestStructuredAgentContextFacts } from '../../../shared/agent-session/structured-agent-session-context-usage'
import {
  newestStructuredAgentSessionTurnBySequence,
  runningStructuredAgentSessionTurnItemBySequence
} from '../../../shared/agent-session/view/structured-agent-session-live-turn'
import { journalThreadGoalSource, type JournalThreadGoalSource } from './journal-thread-goal-source'
import type { JournalItemLinkageVisitor } from './journal-store-contracts'
import type { AgentJournalSnapshot } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { renderJournalState, type JournalReducerState } from './journal-reducer'

/** Only a committed journal owner can certify reuse across public reads. */
export function createJournalPublicReader() {
  let current:
    | {
        raw: JournalReducerState
        epoch: string
        sequence: number
        revision: string
        normalizationKey?: string
        view?: ReturnType<typeof readJournalPublicView>
      }
    | undefined
  return (raw: JournalReducerState, display: JournalReducerState, revision: string) => {
    const { epoch, lastSequence: sequence } = raw
    if (
      current?.raw !== raw ||
      current.epoch !== epoch ||
      current.sequence !== sequence ||
      current.revision !== revision
    ) {
      current = { raw, epoch, sequence, revision }
    }
    const source = current
    return (source.view ??= readJournalPublicView(
      display,
      () => (source.normalizationKey ??= journalNormalizationKey(display))
    ))
  }
}

/** Row progress cannot certify a historical display that the queue fold corrected. */
export function readJournalPublicView(
  state: JournalReducerState,
  normalizationKey = () => journalNormalizationKey(state)
): {
  snapshot: AgentJournalSnapshot
  normalizationKey: string
} {
  let snapshot: AgentJournalSnapshot | undefined
  return {
    get snapshot() {
      return (snapshot ??= renderJournalState(state))
    },
    get normalizationKey() {
      return normalizationKey()
    }
  }
}

function journalNormalizationKey(state: JournalReducerState): string {
  const corrections = [...state.normalizedHandOffs].sort().flatMap((id) => {
    const item = state.items.get(agentJournalSubmissionKey(id))
    const submission = state.submissions.get(id)
    return item && submission
      ? [[id, item.sequence, item.observedAt, item.turnScope, submission.queuedMessageId ?? null]]
      : []
  })
  return corrections.length === 0 ? '' : JSON.stringify([state.epoch, corrections])
}

export function createJournalItemReader(state: () => JournalReducerState) {
  return {
    /** Visit without allocating/sorting a snapshot. */
    visitItems: (
      visit: (itemId: string, sequence: number, body: AgentJournalItemBody) => void
    ): void => {
      for (const item of state().items.values()) {
        visit(item.itemId, item.sequence, item.body)
      }
    },

    itemBody: (itemId: string): AgentJournalItemBody | null =>
      state().items.get(itemId)?.body ?? null,

    /** Host-only stopped-history IDs carried by each send. */
    stoppedHistoryCarried: (): ReadonlyMap<string, readonly string[]> =>
      state().stoppedHistoryCarried,

    item: (itemId: string): AgentJournalRenderItem | null => state().items.get(itemId) ?? null,

    /** Remember publication even after a rewind removes the row. */
    hasRecordedItem: (itemId: string): boolean =>
      state().items.has(itemId) || state().tombstones.has(itemId),

    visitItemsWithLinkage: (visit: JournalItemLinkageVisitor): void => {
      for (const item of state().items.values()) {
        visit(item.itemId, item.sequence, item.body, item)
      }
    },

    /** Read the journal's running turn without allocating a snapshot; host projection decides current work. */
    runningTurn: (): { item: AgentJournalRenderItem; turnId: string } | null =>
      runningStructuredAgentSessionTurnItemBySequence(state().items.values()),

    newestTurn: (): AgentJournalTurnLifecycle | null =>
      newestStructuredAgentSessionTurnBySequence(state().items.values()),

    threadGoalSource: (): JournalThreadGoalSource =>
      journalThreadGoalSource(state().items.values()),

    /** Read across the journal, beyond any client's loaded page. */
    threadGoal: () => journalThreadGoalSource(state().items.values()).goal,

    /** Read across the journal, beyond any client's loaded page. */
    contextUsage: (): AgentSessionContextUsage =>
      latestStructuredAgentContextFacts(state().items.values())
  }
}
