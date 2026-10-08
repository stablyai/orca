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
  /** Host clock at the send that opened the turn; absent when the provider
   *  resumed on its own and no send of Orca's names this turn. */
  requestedAt?: number
  /** Provider key of the user echo, or the lifecycle row itself when provider
   *  output opened a turn with no user row to receive its timing. */
  userItemId: string
  /** Present when the turn is the host's record of a conversation command. */
  command?: ClaudeCommandTurn
}

/** The row a turn's lifecycle lives on: the host's record for a command, else the lane's own. */
export function claudeCurrentTurnIdentity(turn: ClaudeCurrentTurn): AgentJournalItemIdentity {
  return turn.command?.identity ?? claudeTurnLifecycleIdentity(turn.sessionId, turn.turnId)
}

export type ClaudeTurnEnd = {
  state: 'completed' | 'interrupted'
  completedAt: number
  /** An end the provider reported carries its verdict, and a turn a newer one
   *  replaced carries `superseded`. The child going away leaves it absent, which
   *  reads as unknown rather than claiming the turn worked. */
  outcome?: AgentJournalTurnOutcome
  /** The SDK's own measured turn duration; only a result frame carries one. */
  durationMs?: number
}

/** A result the SDK reports as aborted is the user's stop, not the model's end.
 *  The lifecycle state is deliberately unchanged by the outcome: a failed turn
 *  is still a turn the host watched finish, and only `outcome` says it failed. */
export function claudeTurnEndForResult(
  message: Record<string, unknown>,
  completedAt: number,
  leftToStop = false
): ClaudeTurnEnd {
  const outcome = claudeResultOutcome(message, leftToStop)
  const durationMs = message.duration_ms
  return {
    // No verdict: an interrupted end, which a person's Stop of it makes their cancellation.
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
  const { sessionId, turnId, startedAt, requestedAt, userItemId } = turn
  // Write-once: the terminal revision republishes the value the running row
  // already carried, because both are built from the same open turn.
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
    // The running row's ts is the turn start itself, so clients read no append lag.
    options: end ? {} : { observedAt: startedAt },
    publishCoalescingKey: end ? 'publish' : `turn-start:${sessionId}:${turnId}`
  }
}
