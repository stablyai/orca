// What a restart continuation's message settled as, read the way the restart list files it.

import {
  readAgentSessionFailureFact,
  type UnreadAgentSessionFailureFact
} from '../../../shared/agent-session-failure'
import { failedBeforeHandover } from '../../../shared/structured-agent-session-dispatch-rejection'
import type { StructuredAgentSessionContinuationOutcome } from './structured-agent-session-restart-continuation'

export type ContinuationSubmission = {
  dispatchState?: string
  reason?: string | null
  rejection?: UnreadAgentSessionFailureFact
  startRetry?: unknown
  handedOverAt?: number
  handoverRecorded?: true
}

/** The outcome already settled when the message was handed over, or null while it is in flight. */
export function handedOverContinuationOutcome(
  sessionId: string,
  handedOver: ContinuationSubmission | undefined
): StructuredAgentSessionContinuationOutcome | null {
  // No agent took it: the message says why, as any message that failed before handover does.
  if (handedOver && failedBeforeHandover(handedOver)) {
    return { ...refusedBy(sessionId, handedOver), startFailed: true }
  }
  if (handedOver?.dispatchState === 'rejected') {
    return refusedBy(sessionId, handedOver)
  }
  if (handedOver?.dispatchState === 'pending' && handedOver.startRetry !== undefined) {
    return { sessionId, outcome: 'pending', startFailed: true }
  }
  return null
}

function refusedBy(
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

export function continuationVerdict(
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
