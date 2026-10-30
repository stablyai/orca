import type { StructuredAgentSessionCaller } from './structured-agent-session-host-types'
import type { StructuredAgentSessionAttachContext } from './structured-agent-session-attach-context'
import type { AgentSessionAttachParams } from './structured-agent-session-attach'
import { attachStructuredAgentSession } from './structured-agent-session-attach-orchestration'
import {
  createStructuredAgentSession,
  type StructuredAgentSessionCreateOptions
} from './structured-agent-session-create'
import { forkStructuredAgentSession } from './structured-agent-session-fork'
import type { StructuredAgentSessionCreateParams } from '../../../shared/structured-agent-session-create'

export function structuredAgentSessionEntryDelegates(
  context: () => StructuredAgentSessionAttachContext
) {
  return {
    attach: (
      caller: StructuredAgentSessionCaller,
      params: AgentSessionAttachParams,
      options?: Parameters<typeof attachStructuredAgentSession>[3]
    ) => attachStructuredAgentSession(context(), caller.callerKey, params, options),
    create: (
      caller: StructuredAgentSessionCaller,
      params: AgentSessionAttachParams,
      options?: StructuredAgentSessionCreateOptions
    ) => createStructuredAgentSession(context(), caller.callerKey, params, options),
    fork: (
      caller: StructuredAgentSessionCaller,
      params: StructuredAgentSessionCreateParams,
      options?: Parameters<typeof forkStructuredAgentSession>[3]
    ) => forkStructuredAgentSession(context(), caller, params, options)
  }
}
