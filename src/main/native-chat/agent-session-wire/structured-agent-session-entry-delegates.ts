import type { AgentSessionExecutionLocation } from '../../../shared/agent-session-record'
import type { StructuredAgentSessionCaller } from './structured-agent-session-host-types'
import type { StructuredAgentSessionAttachContext } from './structured-agent-session-attach-context'
import type { AgentSessionAttachParams } from './structured-agent-session-attach'
import { attachStructuredAgentSession } from './structured-agent-session-attach-orchestration'
import {
  createStructuredAgentSession,
  type StructuredAgentSessionCreateOptions
} from './structured-agent-session-create'
import { adapterSupportsCreate, knownAgentIds } from './structured-agent-session-provider-support'

/** Host entry points that open a chat: attach an existing one or create a new one. */
export function structuredAgentSessionEntryDelegates(
  context: () => StructuredAgentSessionAttachContext
) {
  return {
    supportsCreate: (location: AgentSessionExecutionLocation, agent: string) =>
      adapterSupportsCreate(context().deps.adapter, location, agent),
    agentDefinitions: () => context().deps.agents.definitions(),
    knownAgentIds: () => knownAgentIds(context().deps),
    attach: (
      caller: StructuredAgentSessionCaller,
      params: AgentSessionAttachParams,
      options?: Parameters<typeof attachStructuredAgentSession>[3]
    ) => attachStructuredAgentSession(context(), caller.callerKey, params, options),
    create: (
      caller: StructuredAgentSessionCaller,
      params: AgentSessionAttachParams,
      options?: StructuredAgentSessionCreateOptions
    ) => createStructuredAgentSession(context(), caller.callerKey, params, options)
  }
}
