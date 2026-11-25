import { isRootAgentJournalItem } from '../../../../shared/agent-session/journal/agent-session-journal-producer'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalRenderItem
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalTurnScope } from '../../../../shared/agent-session/journal/agent-session-journal-turn-scope'
import { readAgentJournalTurn } from '../../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import '../../agent-session-journal/writing/journal-row-builders'
import { journalLifecycleMutationItemId } from '../../agent-session-journal/writing/journal-lifecycle-mutation'
import type { JournalLifecycleMutationInput } from '../../agent-session-journal/writing/journal-lifecycle-mutation'
import type { StructuredAgentSessionTurnVerdict } from './structured-agent-session-stale-turn-verdict'

/** Match the running turn or the translator’s turn ended at this exit instant. */
export function exitedRootTurnScope(
  items: readonly AgentJournalRenderItem[],
  verdict: StructuredAgentSessionTurnVerdict
): AgentJournalTurnScope {
  const endedAt = verdict.state === 'interrupted' ? verdict.completedAt : undefined
  const ended = items.findLast((item) => {
    const turn = isRootAgentJournalItem(item) ? readAgentJournalTurn(item.body) : null
    return (
      turn?.state === 'running' ||
      (turn?.state === 'interrupted' && endedAt !== undefined && turn.completedAt === endedAt)
    )
  })
  return ended ? { kind: 'turn', turnItemId: ended.itemId } : AGENT_JOURNAL_THREAD_SCOPE
}

/** Include previously unverifiable root turns refined by new proof. */
export function settledRootTurnScope(
  items: readonly AgentJournalRenderItem[],
  turnEnds: readonly JournalLifecycleMutationInput[]
): AgentJournalTurnScope {
  const ended = new Set(turnEnds.map(journalLifecycleMutationItemId))
  const settled = items.findLast((item) => isRootAgentJournalItem(item) && ended.has(item.itemId))
  return settled ? { kind: 'turn', turnItemId: settled.itemId } : AGENT_JOURNAL_THREAD_SCOPE
}
