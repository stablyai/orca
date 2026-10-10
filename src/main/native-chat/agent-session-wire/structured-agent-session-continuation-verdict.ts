// What a continuation's send came to, read from its submission: the four dispatch states, never
// collapsed into transport success (`StructuredAgentSessionContinuationOutcome`).

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
  // A start the agent was refused files that refusal's code, which the failure guidance keys on.
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
    // Still pending after settlement gave up: handed off, never confirmed.
    return { sessionId, outcome: 'pending' }
  }
  // `unknown`, or a peer that reported no state at all: delivery is unverifiable, so this claims
  // neither success nor failure — and writes no note saying the agent was asked to continue.
  return dispatch === 'accepted'
    ? { sessionId, outcome: 'continued' }
    : { sessionId, outcome: 'unknown' }
}
