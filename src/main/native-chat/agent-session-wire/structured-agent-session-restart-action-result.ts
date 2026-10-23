// What an explicit restart action reports: every chat it touched, and the rows left after it.

import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'
import type { StructuredAgentSessionContinuationOutcome } from './structured-agent-session-restart-continuation'
import type { StructuredAgentSessionResumeOutcome } from './structured-agent-session-restart-resume-runner'
import type {
  StructuredAgentSessionResumeCandidate,
  StructuredAgentSessionResumeFailure
} from './structured-agent-session-restart-resume-set'

/** Chats the runner turned away before a continuation started, reported as refused. */
export function unstartedRestartRefusals(
  resumed: readonly StructuredAgentSessionResumeOutcome[],
  continued: readonly StructuredAgentSessionContinuationOutcome[]
): StructuredAgentSessionContinuationOutcome[] {
  const refused: StructuredAgentSessionContinuationOutcome[] = []
  for (const outcome of resumed) {
    const reported = (entry: StructuredAgentSessionContinuationOutcome) =>
      entry.sessionId === outcome.sessionId
    if (outcome.outcome !== 'resumed' && !continued.some(reported) && !refused.some(reported)) {
      refused.push({
        sessionId: outcome.sessionId,
        outcome: 'refused',
        reason: outcome.reason ?? 'agent_session_resume_refused'
      })
    }
  }
  return refused
}

/** The rows left after an action; a failed refresh leaves them out instead of failing the action. */
export async function remainingRestartRows(
  list: () => Promise<StructuredAgentSessionResumeCandidate[]>,
  listFailures: () => Promise<StructuredAgentSessionResumeFailure[]>,
  logger: StructuredAgentSessionLogger
): Promise<{
  sessions?: StructuredAgentSessionResumeCandidate[]
  failed?: StructuredAgentSessionResumeFailure[]
}> {
  let sessions: StructuredAgentSessionResumeCandidate[] | undefined
  let failed: StructuredAgentSessionResumeFailure[] | undefined
  try {
    sessions = await list()
    failed = await listFailures()
  } catch {
    logger.warn('refreshing restart offers after an action failed', {
      scope: 'restart-offer-refresh'
    })
  }
  return {
    ...(sessions === undefined ? {} : { sessions }),
    ...(failed === undefined ? {} : { failed })
  }
}
