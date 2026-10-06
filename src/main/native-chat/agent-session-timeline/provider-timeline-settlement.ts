// What a turn's end or the session's end settles, read from the journal when the settlement runs.
//
// The same mechanism, and the same terminal bodies, as the dead-generation settlement after a
// restart: every row still waiting on the row that settles it — a running tool call, a pending
// prompt — is settled from its body as the journal holds it then. Nothing about open work is
// trusted from memory, so a prompt a client answered a moment earlier stays answered, and a
// second settlement finds nothing left to do.

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
import { terminalAgentJournalBody } from '../agent-session-journal/journal-terminal-settlement'
import type { StructuredAgentSessionTransitionJournal } from '../agent-session-wire/structured-agent-session-transition'
import {
  agentJournalTurnRowReservedBytes,
  resolveAgentJournalTurnRowWrite
} from './agent-journal-turn-row-revision'

/** How a turn ended: the provider's report, or what the host could prove when the child went. */
export type ProviderTimelineTurnEnd =
  | {
      state: 'completed' | 'interrupted'
      completedAt: number
      outcome?: AgentJournalTurnLifecycle['outcome']
      durationMs?: number
    }
  | { state: 'unverifiable' }

/** The end owns the turn's terminal fields; `unverifiable` carries no end and no verdict. Fields
 *  keep the order every lane writes them in, so the row is the same bytes whoever ends it. */
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
    completedAt: end.completedAt,
    ...(end.durationMs !== undefined ? { durationMs: end.durationMs } : {})
  }
}

/** Which open rows a settlement covers: one turn's, or every row when the session ends. A turn
 *  another writer settled covers only its prompts: its tool calls are the provider's to finish. */
export type ProviderTimelineSettlementScope = { turnItemId: string; promptsOnly?: true } | 'session'

/** The turns a settlement ends, and how; absent when another writer already ended the turn. */
export type ProviderTimelineSettlementEnding = {
  turns: readonly { identity: AgentJournalItemIdentity; itemId: string }[]
  end: ProviderTimelineTurnEnd
}

/** The settled rows of `scope`, then each ended turn's row while the journal holds it running. */
export function providerTimelineSettlement(
  journal: StructuredAgentSessionTransitionJournal,
  scope: ProviderTimelineSettlementScope,
  ending?: ProviderTimelineSettlementEnding
): JournalLifecycleMutationInput[] {
  const mutations: JournalLifecycleMutationInput[] = []
  journal.visitItemsWithLinkage((itemId, _sequence, body, attribution) => {
    const turnScope = attribution.turnScope ?? AGENT_JOURNAL_THREAD_SCOPE
    const covered =
      scope === 'session' ||
      (turnScope.kind === 'turn' &&
        turnScope.turnItemId === scope.turnItemId &&
        !(scope.promptsOnly && body.kind === 'tool-call'))
    // Background tasks and subagents outlive turns; only the session's end leaves them past seeing.
    const settled = !covered
      ? null
      : (terminalAgentJournalBody(body) ??
        (scope === 'session' ? lostLiveWorkJournalBody(body) : null))
    const identity = settled ? parseAgentJournalItemKey(itemId) : null
    if (settled && identity) {
      // No linkage: a revision keeps the row's own producer.
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

/** Every turn row the journal holds running, for the session's end. */
export function runningProviderTimelineTurns(
  journal: StructuredAgentSessionTransitionJournal
): { identity: AgentJournalItemIdentity; itemId: string }[] {
  const running: { identity: AgentJournalItemIdentity; itemId: string }[] = []
  journal.visitItems((itemId, _sequence, body) => {
    const identity =
      readAgentJournalTurn(body)?.state === 'running' ? parseAgentJournalItemKey(itemId) : null
    if (identity) {
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
    // Defence only: the check above reads the same snapshot; the revision refuses an ended row too.
    onlyWhileRunning: true as const
  }
  return resolveAgentJournalTurnRowWrite(
    journal,
    target,
    write,
    agentJournalTurnRowReservedBytes(target, write)
  )
}
