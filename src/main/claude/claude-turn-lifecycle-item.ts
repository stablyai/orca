import type {
  AgentJournalItemIdentity,
  AgentJournalTurnItem
} from '../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import { agentJournalTurnBody } from '../../shared/agent-session-turn-record'
import type { StructuredAgentSessionAppendOptions } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { claudeText } from './claude-structured-item-translation'

export type ClaudeCurrentTurn = {
  sessionId: string
  turnId: string
  startedAt: number
  /** Host clock when the send that opened this turn was accepted. Held for the
   *  life of the turn so every revision restates it rather than re-deriving it. */
  requestedAt?: number
  /** Provider key of the user echo, or the lifecycle row itself when provider
   *  output opened a turn with no user row to receive its timing. */
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

/** Keep provider-resumed timing off the preceding prompt on clients that treat
 *  a missing user key as an older-host lifecycle row. */
export function claudeProviderResumedTurnTimingAnchor(sessionId: string, turnId: string): string {
  return agentJournalItemKey(claudeTurnLifecycleIdentity(sessionId, turnId))
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
  const { sessionId, turnId, startedAt, userItemId, requestedAt } = turn
  const accepted = requestedAt === undefined ? {} : { requestedAt }
  return {
    identity: claudeTurnLifecycleIdentity(sessionId, turnId),
    body: agentJournalTurnBody(
      end
        ? {
            turnId,
            state: end.state,
            ...accepted,
            startedAt,
            completedAt: end.completedAt,
            userItemId,
            ...(end.durationMs === undefined ? {} : { durationMs: end.durationMs })
          }
        : { turnId, state: 'running', ...accepted, startedAt, userItemId }
    ),
    // The running row's ts is the turn start itself, so clients read no append lag.
    options: end ? {} : { observedAt: startedAt },
    publishCoalescingKey: end ? 'publish' : `turn-start:${sessionId}:${turnId}`
  }
}
