import type { AgentSessionOpenReasoning } from '../../shared/agent-session-wire'
import type { TurnActivityChannel } from '../native-chat/agent-session-wire/turn-activity-channel'
import type { CodexActiveJournalItem } from './codex-structured-journal-contracts'
import type { CodexJournalActiveTurns } from './codex-structured-journal-translation-turn-state'
import type { CodexRowAttribution } from './codex-subagent-linkage'

type CodexOpenReasoningInput = {
  activeItems: ReadonlyMap<string, CodexActiveJournalItem>
  primaryThreadId: string | null
  activeTurns: Pick<CodexJournalActiveTurns, 'byThread' | 'current'>
  attributionFor: CodexRowAttribution
}

/** Who has a reasoning item open right now, read from the same live item set that closes reasoning
 *  rows: the primary thread is the session's own agent, any other thread a subagent by the producer
 *  id its rows carry. Only items inside a turn still running count. */
export function codexOpenReasoning(input: CodexOpenReasoningInput): AgentSessionOpenReasoning {
  let session = false
  const subagents: string[] = []
  for (const active of input.activeItems.values()) {
    if (
      active.item.type !== 'reasoning' ||
      active.turnId === null ||
      input.activeTurns.byThread.get(active.threadId)?.has(active.turnId) !== true
    ) {
      continue
    }
    if (active.threadId === input.primaryThreadId) {
      session = true
      continue
    }
    const agentId = input.attributionFor(active.threadId, active.turnId).agentId
    if (agentId) {
      subagents.push(agentId)
    }
  }
  return { session, subagents }
}

/** Publishes it on the primary thread's running turn, the turn the live line belongs to. */
export function publishCodexOpenReasoning(
  activity: Pick<TurnActivityChannel, 'setReasoning'>,
  input: CodexOpenReasoningInput
): void {
  activity.setReasoning(
    input.primaryThreadId === null ? null : input.activeTurns.current(input.primaryThreadId),
    codexOpenReasoning(input)
  )
}
