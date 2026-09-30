// Which turn a gone generation's exit row belongs to, so the row reports on the turn it ended.

import { isRootAgentJournalItem } from '../../../shared/agent-session-journal-producer'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalRenderItem,
  type AgentJournalTurnScope
} from '../../../shared/agent-session-journal-types'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import type { StructuredAgentSessionTurnVerdict } from './structured-agent-session-stale-turn-verdict'

/** The turn the exit ended: still running, or already ended at the exit's instant by the child's
 *  own translator, which settles its open turn when the child goes. */
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

export function runningRootTurnScope(
  items: readonly AgentJournalRenderItem[]
): AgentJournalTurnScope {
  const running = items.findLast(
    (item) => isRootAgentJournalItem(item) && readAgentJournalTurn(item.body)?.state === 'running'
  )
  return running ? { kind: 'turn', turnItemId: running.itemId } : AGENT_JOURNAL_THREAD_SCOPE
}
