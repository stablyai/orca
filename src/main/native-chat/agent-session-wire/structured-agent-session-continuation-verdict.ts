// Preserve dispatch outcomes; transport success alone cannot prove continuation.

import {
  readAgentSessionFailureFact,
  type UnreadAgentSessionFailureFact
} from '../../../shared/agent-session-failure'
import type { StructuredAgentSessionContinuationOutcome } from './structured-agent-session-restart-continuation'

export type ContinuationSubmission = {
  dispatchState?: string
  reason?: string | null
  rejection?: UnreadAgentSessionFailureFact
}

export function refusedBy(
  sessionId: string,
  submission: ContinuationSubmission
): StructuredAgentSessionContinuationOutcome {
  // Failure guidance uses the typed start-refusal code.
  const refusal = readAgentSessionFailureFact(submission.rejection)?.refusal
  return {
    sessionId,
    outcome: 'refused',
    reason: refusal?.code ?? submission.reason ?? 'agent_session_dispatch_rejected',
    ...(refusal ? { refusal } : {})
  }
}

export function verdictOf(
  sessionId: string,
  submission: ContinuationSubmission | undefined
): StructuredAgentSessionContinuationOutcome {
  const dispatch = submission?.dispatchState
  if (submission && dispatch === 'rejected') {
    return refusedBy(sessionId, submission)
  }
  if (dispatch === 'pending') {
    return { sessionId, outcome: 'pending' }
  }
  // Missing/unknown peer state proves neither success nor failure; do not write a continuation note.
  return dispatch === 'accepted'
    ? { sessionId, outcome: 'continued' }
    : { sessionId, outcome: 'unknown' }
}
