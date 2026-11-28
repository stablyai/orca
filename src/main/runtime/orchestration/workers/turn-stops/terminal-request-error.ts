// The failure a terminal agent's turn ended on, worded as a chat worker's is.
import type { AgentStatusIpcPayload } from '../../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import { agentSessionFailureWords } from '../../../../../shared/agent-session/failures/agent-session-failure-words'
import { claudeStopFailureFact } from '../../../../claude/structured/journal/claude-usage-limits'
import { failureRequestError } from './chat-worker-error-words'
import { redactFailure } from './worker-turn-stop-wording'
import type { WorkerRequestError } from './worker-turn-stop-report'

/** The typed failure a terminal agent's turn ended on; null when it named none Orca words. */
export function terminalRequestError(row: AgentStatusIpcPayload): WorkerRequestError | null {
  // A time-only reset is read against when the turn stopped: a pane restored later keeps that day.
  const fact =
    row.agentType === 'claude'
      ? claudeStopFailureFact(row.mainAgent?.failure, row.mainAgent?.stateStartedAt ?? Date.now())
      : null
  if (!fact) {
    return null
  }
  const words = agentSessionFailureWords(fact, {
    agentName: 'Claude',
    provider: 'claude',
    surface: 'row'
  })
  const error = failureRequestError(words.text, fact)
  const text = redactFailure(error.text)
  const detail = error.detail && redactFailure(error.detail)
  const resetsAt = fact.kind === 'usageLimitReached' ? fact.usageLimit?.resetsAt : undefined
  return {
    text,
    ...(detail ? { detail } : {}),
    kind: fact.kind,
    heldByWaits: true,
    ...(resetsAt !== undefined ? { usageLimit: { resetsAt } } : {}),
    facts: {
      stopReason: 'errored',
      agent: 'claude',
      turnOutcome: 'failure',
      failureKind: fact.kind,
      error: text,
      ...(detail ? { detail } : {}),
      ...(resetsAt !== undefined ? { resetsAt: new Date(resetsAt).toISOString() } : {})
    }
  }
}
