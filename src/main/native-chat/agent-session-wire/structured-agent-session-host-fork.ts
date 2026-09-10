import type { AgentSessionForkSource } from '../../../shared/agent-session-fork'
import type {
  AgentSessionAttachResult,
  AgentSessionMutationResult
} from '../../../shared/agent-session-wire'
import type { AgentSessionAttachParams } from './structured-agent-session-attach'
import type { StructuredAgentSessionAttachContext } from './structured-agent-session-attach-context'
import { forkStructuredAgentSession } from './structured-agent-session-fork'
import type { StructuredAgentSessionCaller } from './structured-agent-session-host-types'

export function createStructuredAgentSessionFork(
  attachContext: () => StructuredAgentSessionAttachContext
) {
  return async (
    caller: StructuredAgentSessionCaller,
    params: AgentSessionAttachParams,
    source: AgentSessionForkSource
  ): Promise<AgentSessionMutationResult<AgentSessionAttachResult>> => {
    const context = attachContext()
    // The one choke point that sees every fork outcome with both session ids. Refusals raised past
    // the fork's own vocabulary carry no `forkReason`, and the client can only render them as one
    // generic sentence — without this line a failed fork left NO main-process trace to debug from.
    const ids = `source=${source.sessionId} child=${params.envelope.sessionId}`
    try {
      const result = await forkStructuredAgentSession(context, context, caller, params, source)
      if (!result.ok) {
        console.warn(
          `[agent-session] fork refused: ${ids} code=${result.refusal.code} ` +
            `reason=${result.refusal.forkReason ?? 'none'} — ${result.refusal.message}`
        )
      }
      return result
    } catch (error) {
      console.warn(`[agent-session] fork failed before it could refuse: ${ids}`, error)
      throw error
    }
  }
}
