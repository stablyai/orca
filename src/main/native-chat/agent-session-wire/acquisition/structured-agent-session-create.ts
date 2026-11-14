import { foundConversation } from './structured-agent-session-create-founding'
import type { StructuredAgentSessionFirstMessage } from '../../../../shared/agent-session/structured-agent-session-create'
import { isAgentSessionRefusalError } from '../../../../shared/agent-session/failures/agent-session-wire-refusals'
import type {
  AgentSessionAttachResult,
  AgentSessionMutationResult
} from '../../../../shared/agent-session/agent-session-wire'
import type { StructuredAgentSessionCaller } from '../host/structured-agent-session-host-types'
import type { StructuredAgentSessionAttachContext } from './structured-agent-session-attach-context'
import type { reserveRequestFor, AgentSessionAttachParams } from './structured-agent-session-attach'

export type StructuredAgentSessionCreateOptions = {
  firstMessage?: StructuredAgentSessionFirstMessage
  hostLaunchDirectory?: string
  catalogModels?: Parameters<typeof reserveRequestFor>[0]['models']
  /** Publish after durable creation, before agent delivery starts. */
  publishTab?: () => Promise<void>
}

export function createStructuredAgentSession(
  context: StructuredAgentSessionAttachContext,
  caller: StructuredAgentSessionCaller,
  params: AgentSessionAttachParams,
  options: StructuredAgentSessionCreateOptions = {}
): Promise<AgentSessionMutationResult<AgentSessionAttachResult>> {
  return context.tasks.trackAttach(
    context.serialize(params.envelope.sessionId, async () => {
      try {
        return await foundConversation(context, caller, params, options)
      } catch (error) {
        if (isAgentSessionRefusalError(error)) {
          return { ok: false, refusal: error.refusal }
        }
        throw error
      } finally {
        await params.fork?.prepared.close()
      }
    }),
    { sessionId: params.envelope.sessionId, location: params.location }
  )
}
