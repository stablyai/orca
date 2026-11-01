import type { StructuredAgentSessionState } from '../../../src/shared/structured-agent-session-reducer'
import {
  runningStructuredAgentSessionTurnId,
  structuredAgentSessionHostSaysWorking
} from '../../../src/shared/structured-agent-session-live-turn'
import { isStructuredAgentSessionMainAgentWorking } from '../../../src/shared/structured-agent-session-main-agent-working'

export function mobileStructuredAgentSessionWorking(state: StructuredAgentSessionState): boolean {
  return structuredAgentSessionHostSaysWorking(state.working, () =>
    isStructuredAgentSessionMainAgentWorking(
      runningStructuredAgentSessionTurnId(state),
      state.submissions,
      state.fence
    )
  )
}
