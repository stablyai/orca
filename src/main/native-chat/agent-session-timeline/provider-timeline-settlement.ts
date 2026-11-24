import { isHistoricalProviderTimelineItem } from './provider-timeline-history'
// The writer resolves unsettled work from its selected rows, using the same terminal forms as dead-generation recovery.
// Preserve client answers and other writers’ settlements; repeated settlement writes nothing.

import { parseAgentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemBody,
  type AgentJournalTurnLifecycle
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalItemIdentity } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import {
  agentJournalTurnBody,
  readAgentJournalTurn
} from '../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import type { JournalLifecycleMutationInput } from '../agent-session-journal/writing/journal-lifecycle-mutation'
import { lostLiveWorkJournalBody } from '../agent-session-journal/item-lifecycle/journal-subagent-liveness'
import {
  runningCallEnd,
  terminalAgentJournalBody
} from '../agent-session-journal/item-lifecycle/journal-terminal-settlement'
import type { JournalTimelineView } from '../agent-session-journal/writing/journal-timeline-view'
import {
  agentJournalTurnRowReservedBytes,
  resolveAgentJournalTurnRowWrite
} from './agent-journal-turn-row-revision'

export type ProviderTimelineTurnEnd =
  | {
      state: 'completed' | 'interrupted'
      /** Unknown end times remain absent. */
      completedAt?: number
      outcome?: AgentJournalTurnLifecycle['outcome']
      durationMs?: number
    }
  | { state: 'unverifiable' }

/** Unverifiable turns have no end/verdict; preserve canonical field order for byte-identical rows. */
export function endedProviderTimelineTurn(
  running: AgentJournalTurnLifecycle,
  end: ProviderTimelineTurnEnd
): AgentJournalTurnLifecycle {
  const { turnId, userItemId, startedAt, requestedAt } = running
  const opened = {
    ...(userItemId !== undefined ? { userItemId } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(requestedAt !== undefined ? { requestedAt } : {})
  }
  if (end.state === 'unverifiable') {
    return { turnId, state: 'unverifiable', ...opened }
  }
  return {
    turnId,
    state: end.state,
    ...(end.outcome !== undefined ? { outcome: end.outcome } : {}),
    ...opened,
    ...(end.completedAt !== undefined ? { completedAt: end.completedAt } : {}),
    ...(end.durationMs !== undefined ? { durationMs: end.durationMs } : {})
  }
}

export type ProviderTimelineSettlementScope = { turnItemId: string } | 'session'

/** Without ending, settle prompts only; running tools remain the provider’s responsibility. */
export type ProviderTimelineSettlementEnding = {
  turns: readonly { identity: AgentJournalItemIdentity; itemId: string }[]
  end: ProviderTimelineTurnEnd
  /** Observed session-end time marks live subagents’ contact loss. */
  lostAt?: number
}

export function providerTimelineSettlement(
  view: JournalTimelineView,
  scope: ProviderTimelineSettlementScope,
  ending?: ProviderTimelineSettlementEnding,
  keep?: ReadonlySet<string>
): JournalLifecycleMutationInput[] {
  const mutations: JournalLifecycleMutationInput[] = []
  for (const item of view.unsettled(scope === 'session' ? null : scope.turnItemId)) {
    const { itemId, body } = item
    if (keep?.has(itemId)) {
      continue
    }
    const turnScope = item.turnScope ?? AGENT_JOURNAL_THREAD_SCOPE
    if (scope === 'session' && isHistoricalProviderTimelineItem(item, view.item)) {
      continue
    }
    const end =
      ending && body.kind === 'tool-call' && body.state === 'running'
        ? runningCallEnd(turnScope, view.itemBody, ending.end.state)
        : null
    // Background tasks/subagents outlive turns; only session end proves contact loss.
    const settled =
      terminalAgentJournalBody(body, end) ??
      (scope === 'session' ? lostLiveWorkJournalBody(body, ending?.lostAt) : null)
    const identity = settled ? parseAgentJournalItemKey(itemId) : null
    if (settled && identity) {
      // Omitted linkage preserves the original producer.
      mutations.push({ kind: 'item', identity, body: settled, turnScope })
    }
  }
  for (const turn of ending?.turns ?? []) {
    const ended = ending ? endedTurnRow(view, turn, ending.end) : null
    if (ended) {
      mutations.push({ kind: 'item', ...ended, turnScope: AGENT_JOURNAL_THREAD_SCOPE })
    }
  }
  return mutations
}

export function runningProviderTimelineTurns(
  view: JournalTimelineView
): { identity: AgentJournalItemIdentity; itemId: string }[] {
  const running: { identity: AgentJournalItemIdentity; itemId: string }[] = []
  for (const item of view.unsettled(null)) {
    const identity =
      readAgentJournalTurn(item.body)?.state === 'running'
        ? parseAgentJournalItemKey(item.itemId)
        : null
    if (identity && !isHistoricalProviderTimelineItem(item, view.item)) {
      running.push({ identity, itemId: item.itemId })
    }
  }
  return running
}

function endedTurnRow(
  view: JournalTimelineView,
  turn: { identity: AgentJournalItemIdentity; itemId: string },
  end: ProviderTimelineTurnEnd
): { identity: AgentJournalItemIdentity; body: AgentJournalItemBody } | null {
  const running = readAgentJournalTurn(view.itemBody(turn.itemId) ?? undefined)
  if (running?.state !== 'running') {
    return null
  }
  const target = { identity: turn.identity }
  const write = {
    lifecycle: agentJournalTurnBody(endedProviderTimelineTurn(running, end)),
    // Recheck in revision even though the snapshot already showed running.
    onlyWhileRunning: true as const
  }
  return resolveAgentJournalTurnRowWrite(
    view,
    target,
    write,
    agentJournalTurnRowReservedBytes(target, write)
  )
}
