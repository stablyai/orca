import type {
  AgentJournalItemIdentity,
  AgentJournalTurnItem,
  AgentJournalTurnOutcome
} from '../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import { agentJournalTurnBody } from '../../shared/agent-session-turn-record'
import type { StructuredAgentSessionAppendOptions } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { claudeResultOutcome } from './claude-result-outcome'
import type { ClaudeCommandTurn } from './claude-command-turn'

export type ClaudeCurrentTurn = {
  sessionId: string
  turnId: string
  startedAt: number
  /** Host submission time; absent when the provider resumes without an Orca send. */
  requestedAt?: number
  /** Anchor to the user echo, an unechoed started submission, or the provider-resumed lifecycle row. */
  userItemId: string
  command?: ClaudeCommandTurn
}

export function claudeCurrentTurnIdentity(turn: ClaudeCurrentTurn): AgentJournalItemIdentity {
  return turn.command?.identity ?? claudeTurnLifecycleIdentity(turn.sessionId, turn.turnId)
}

export type ClaudeTurnEnd = {
  state: 'completed' | 'interrupted'
  completedAt: number
  /** Provider verdict or superseded; child exit leaves an unknown outcome. */
  outcome?: AgentJournalTurnOutcome
  /** SDK-measured duration, available only on result frames. */
  durationMs?: number
}

/** Failed results complete normally; cancellation or a deferred Stop verdict interrupts the turn. */
export function claudeTurnEndForResult(
  message: Record<string, unknown>,
  completedAt: number,
  leftToStop = false
): ClaudeTurnEnd {
  const outcome = claudeResultOutcome(message, leftToStop)
  const durationMs = message.duration_ms
  return {
    state: outcome === undefined || outcome === 'cancellation' ? 'interrupted' : 'completed',
    completedAt,
    ...(outcome !== undefined ? { outcome } : {}),
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

/** Anchor provider-resumed timing separately from preceding prompts on older clients. */
export function claudeProviderResumedTurnTimingAnchor(sessionId: string, turnId: string): string {
  return agentJournalItemKey(claudeTurnLifecycleIdentity(sessionId, turnId))
}

/** Revise lifecycle rows instead of tombstoning them so host-clock endpoints survive. */
export function claudeTurnLifecycleItem(
  turn: ClaudeCurrentTurn,
  end?: ClaudeTurnEnd
): {
  identity: AgentJournalItemIdentity
  body: AgentJournalTurnItem
  options: StructuredAgentSessionAppendOptions
  publishCoalescingKey: string
} {
  const { sessionId, turnId, startedAt, requestedAt, userItemId } = turn
  const requested = requestedAt === undefined ? {} : { requestedAt }
  return {
    identity: claudeCurrentTurnIdentity(turn),
    body: agentJournalTurnBody(
      end
        ? {
            turnId,
            state: end.state,
            ...(end.outcome === undefined ? {} : { outcome: end.outcome }),
            startedAt,
            ...requested,
            completedAt: end.completedAt,
            userItemId,
            ...(end.durationMs === undefined ? {} : { durationMs: end.durationMs })
          }
        : { turnId, state: 'running', startedAt, ...requested, userItemId }
    ),
    // Use the turn start timestamp so append latency does not inflate timing.
    options: end ? {} : { observedAt: startedAt },
    publishCoalescingKey: end ? 'publish' : `turn-start:${sessionId}:${turnId}`
  }
}
