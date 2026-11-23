import { structuredAgentSessionAwaitsAnswer } from '../../../../shared/agent-session/view/structured-agent-session-async-questions'
import {
  foldAgentLeadStatus,
  heldTurnCountsAsFinished
} from '../../../../shared/agent-status/lifecycle/agent-lead-status-fold'
import {
  agentChildWorkLiveness,
  type AgentChildWorkLivenessCandidate
} from '../../../../shared/agent-status/child-work/agent-status-child-work-liveness'
import type { StructuredAgentSessionLatestRequest } from '../../../../shared/agent-session/requests/structured-agent-session-latest-request'
import type { StructuredAgentSessionStatusState } from './structured-agent-session-status-journal-projection'

/** What holds a successful turn's end: a continuing goal, or running workers (the combined row would
 *  not be done). Null when it is finished now. */
export function structuredAgentSessionTurnHold(
  state: StructuredAgentSessionStatusState,
  request: StructuredAgentSessionLatestRequest,
  childWork: readonly AgentChildWorkLivenessCandidate[] | undefined,
  asyncQuestionsSkippedThrough: string | undefined
): 'goal' | 'workers' | null {
  if (request.outcome !== 'success' || state.summary.status === 'attention') {
    return null
  }
  // An open async question pauses the goal on the user, so it is news now.
  if (
    state.goalContinues &&
    !structuredAgentSessionAwaitsAnswer(
      state.summary.openAsyncQuestion,
      asyncQuestionsSkippedThrough
    )
  ) {
    return 'goal'
  }
  const held = foldAgentLeadStatus({
    leadState: 'done',
    childWorkLiveness: agentChildWorkLiveness(childWork)
  })
  return held.stateName !== 'done' &&
    !heldTurnCountsAsFinished(held, request.outcome, request.selfStarted === true)
    ? 'workers'
    : null
}
