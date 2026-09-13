import type {
  AgentJournalItemIdentity,
  AgentJournalTurnItem
} from '../../shared/agent-session-journal-types'
import { agentJournalTurnBody } from '../../shared/agent-session-turn-record'
import type { StructuredAgentSessionAppendOptions } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { claudeText } from './claude-structured-item-translation'

export type ClaudeCurrentTurn = {
  sessionId: string
  turnId: string
  startedAt: number
  /** Provider key of the user echo that opened the turn. */
  userItemId: string
}

export type ClaudeTurnEnd = {
  state: 'completed' | 'interrupted'
  completedAt: number
  /** The SDK's own measured turn duration; only a result frame carries one. */
  durationMs?: number
}

/** A result the SDK reports as aborted is the user's stop, not the model's end. */
export function claudeTurnEndForResult(
  message: Record<string, unknown>,
  completedAt: number
): ClaudeTurnEnd {
  const reason = message.is_error === true ? claudeText(message.terminal_reason) : null
  const durationMs = message.duration_ms
  return {
    state:
      reason === 'aborted_streaming' || reason === 'aborted_tools' ? 'interrupted' : 'completed',
    completedAt,
    ...(typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs >= 0
      ? { durationMs }
      : {})
  }
}

export function claudeTurnLifecycleIdentity(
  sessionId: string,
  turnId: string
): AgentJournalItemIdentity {
  return {
    provider: 'legacy',
    agent: 'claude',
    sessionId,
    recordId: `turn-lifecycle:${turnId}`
  }
}

/** The lifecycle row is revised to its terminal state, never tombstoned, so the
 *  turn's host-clock endpoints outlive the turn. */
export function claudeTurnLifecycleItem(
  turn: ClaudeCurrentTurn,
  end?: ClaudeTurnEnd
): {
  identity: AgentJournalItemIdentity
  body: AgentJournalTurnItem
  options: StructuredAgentSessionAppendOptions
  publishCoalescingKey: string
} {
  const { sessionId, turnId, startedAt, userItemId } = turn
  return {
    identity: claudeTurnLifecycleIdentity(sessionId, turnId),
    body: agentJournalTurnBody(
      end
        ? {
            turnId,
            state: end.state,
            startedAt,
            completedAt: end.completedAt,
            userItemId,
            ...(end.durationMs === undefined ? {} : { durationMs: end.durationMs })
          }
        : { turnId, state: 'running', startedAt, userItemId }
    ),
    // The running row's ts is the turn start itself, so clients read no append lag.
    options: end ? {} : { observedAt: startedAt },
    publishCoalescingKey: end ? 'publish' : `turn-start:${sessionId}:${turnId}`
  }
}
