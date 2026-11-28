import { foundConversation } from './structured-agent-session-create-founding'
import { isAgentSessionRefusalError } from '../../../../shared/agent-session/failures/agent-session-wire-refusals'
import type {
  AgentSessionAttachResult,
  AgentSessionMutationResult
} from '../../../../shared/agent-session/agent-session-wire'
import type { StructuredAgentSessionCaller } from '../host/structured-agent-session-host-types'
import type { StructuredAgentSessionAttachContext } from './structured-agent-session-attach-context'
import type { AgentSessionAttachParams } from './structured-agent-session-attach'
import {
  isSlackExecutionId,
  slackExecutionMutationRefusal
} from '../operations/slack-execution-authority'

export type { StructuredAgentSessionCreateOptions } from './structured-agent-session-create-options'
import type { StructuredAgentSessionCreateOptions } from './structured-agent-session-create-options'

export function createStructuredAgentSession(
  context: StructuredAgentSessionAttachContext,
  caller: StructuredAgentSessionCaller,
  params: AgentSessionAttachParams,
  options: StructuredAgentSessionCreateOptions = {}
): Promise<AgentSessionMutationResult<AgentSessionAttachResult>> {
  return context.tasks.trackAttach(
    context.serialize(params.envelope.sessionId, async () => {
      try {
        if (isSlackExecutionId(params.envelope.sessionId) && options.firstMessage) {
          return slackExecutionMutationRefusal()
        }
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
