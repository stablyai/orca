import type { StructuredAgentSessionState } from '../../../src/shared/structured-agent-session-reducer'
import {
  runningStructuredAgentSessionTurnId,
  structuredAgentSessionHostSaysWorking
} from '../../../src/shared/structured-agent-session-live-turn'
import { isStructuredAgentSessionMainAgentWorking } from '../../../src/shared/structured-agent-session-main-agent-working'

export function mobileStructuredAgentSessionWorking(state: StructuredAgentSessionState): boolean {
  return structuredAgentSessionHostSaysWorking(state.working, () =>
    mobileStructuredAgentSessionOwesWork(state)
  )
}

/** The journal's own rule: a running turn or an unanswered send, whatever the host shows. */
export function mobileStructuredAgentSessionOwesWork(state: StructuredAgentSessionState): boolean {
  return isStructuredAgentSessionMainAgentWorking(
    runningStructuredAgentSessionTurnId(state),
    state.submissions,
    state.fence
  )
}
