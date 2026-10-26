import { isHistoricalProviderTimelineItem } from './provider-timeline-history'
// Resolve unsettled work from journal bodies, using the same terminal forms as dead-generation recovery.
// Preserve client answers and other writers’ settlements; repeated settlement writes nothing.

import { parseAgentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemBody,
  type AgentJournalItemIdentity,
  type AgentJournalTurnLifecycle
} from '../../../shared/agent-session-journal-types'
import {
  agentJournalTurnBody,
  readAgentJournalTurn
} from '../../../shared/agent-session-turn-record'
import type { JournalLifecycleMutationInput } from '../agent-session-journal/journal-row-builders'
import { lostLiveWorkJournalBody } from '../agent-session-journal/journal-subagent-liveness'
import {
  runningCallEnd,
  terminalAgentJournalBody
} from '../agent-session-journal/journal-terminal-settlement'
import type { StructuredAgentSessionTransitionJournal } from '../agent-session-wire/structured-agent-session-transition'
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
  journal: StructuredAgentSessionTransitionJournal,
  scope: ProviderTimelineSettlementScope,
  ending?: ProviderTimelineSettlementEnding
): JournalLifecycleMutationInput[] {
  const mutations: JournalLifecycleMutationInput[] = []
  journal.visitItemsWithLinkage((itemId, _sequence, body, attribution) => {
    const turnScope = attribution.turnScope ?? AGENT_JOURNAL_THREAD_SCOPE
    const historical = scope === 'session' && journal.item(itemId)
    if (historical && isHistoricalProviderTimelineItem(historical, (key) => journal.item(key))) {
      return
    }
    const covered =
      scope === 'session' ||
      (turnScope.kind === 'turn' && turnScope.turnItemId === scope.turnItemId)
    const end =
      covered && ending && body.kind === 'tool-call' && body.state === 'running'
        ? runningCallEnd(turnScope, (turnItemId) => journal.itemBody(turnItemId), ending.end.state)
        : null
    // Background tasks/subagents outlive turns; only session end proves contact loss.
    const settled = !covered
      ? null
      : (terminalAgentJournalBody(body, end) ??
        (scope === 'session' ? lostLiveWorkJournalBody(body, ending?.lostAt) : null))
    const identity = settled ? parseAgentJournalItemKey(itemId) : null
    if (settled && identity) {
      // Omitted linkage preserves the original producer.
      mutations.push({ kind: 'item', identity, body: settled, turnScope })
    }
  })
  for (const turn of ending?.turns ?? []) {
    const ended = ending ? endedTurnRow(journal, turn, ending.end) : null
    if (ended) {
      mutations.push({ kind: 'item', ...ended, turnScope: AGENT_JOURNAL_THREAD_SCOPE })
    }
  }
  return mutations
}

export function runningProviderTimelineTurns(
  journal: StructuredAgentSessionTransitionJournal
): { identity: AgentJournalItemIdentity; itemId: string }[] {
  const running: { identity: AgentJournalItemIdentity; itemId: string }[] = []
  journal.visitItems((itemId, _sequence, body) => {
    const identity =
      readAgentJournalTurn(body)?.state === 'running' ? parseAgentJournalItemKey(itemId) : null
    const item = journal.item(itemId)
    if (identity && item && !isHistoricalProviderTimelineItem(item, (key) => journal.item(key))) {
      running.push({ identity, itemId })
    }
  })
  return running
}

function endedTurnRow(
  journal: StructuredAgentSessionTransitionJournal,
  turn: { identity: AgentJournalItemIdentity; itemId: string },
  end: ProviderTimelineTurnEnd
): { identity: AgentJournalItemIdentity; body: AgentJournalItemBody } | null {
  const running = readAgentJournalTurn(journal.itemBody(turn.itemId) ?? undefined)
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
    journal,
    target,
    write,
    agentJournalTurnRowReservedBytes(target, write)
  )
}
