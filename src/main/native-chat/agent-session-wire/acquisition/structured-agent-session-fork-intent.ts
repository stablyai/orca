import type { StructuredAgentSessionForkSource } from '../../../../shared/agent-session/lifecycle/operations/structured-agent-session-create'
import { prepareStructuredAgentSessionCurrentFork } from './structured-agent-session-current-fork'
import { prepareStructuredAgentSessionFork } from './structured-agent-session-fork'
import { resolveCommittedStructuredAgentSessionAdoptionIntent } from '../../../runtime/agent-session/ownership/structured-agent-session-create-adoption'
import { agentConversationCopyRefusal } from '../../conversation-adoption/agent-conversation-copy-error'
import { acpAgentName } from '../../../acp/session/acp-structured-agent-definitions'
import type { AgentSessionExecutionLocation } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import type { StructuredAgentId } from '../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle'
import type { StructuredAgentSessionHost } from '../host/structured-agent-session-host'
import type { AgentSessionAttachParams } from './structured-agent-session-attach'

export async function resolveStructuredAgentSessionForkIntent(input: {
  host: StructuredAgentSessionHost | null
  forkFrom: StructuredAgentSessionForkSource
  agent: StructuredAgentId
  location: AgentSessionExecutionLocation
  envelope: { sessionId: string; clientOperationId: string }
  callerKey?: string
}): Promise<AgentSessionAttachParams & { hostLaunchDirectory?: string }> {
  const { host } = input
  if (!host) {
    throw agentConversationCopyRefusal(
      'structured_agent_session_unsupported',
      { reason: 'hostUnsupported' },
      `${acpAgentName(input.agent)} could not reach the execution host. Reconnect to the host, then try again.`
    )
  }
  if (input.forkFrom.current) {
    return (
      resolveCommittedStructuredAgentSessionAdoptionIntent({ ...input, host }) ??
      prepareStructuredAgentSessionCurrentFork({ ...input, host, forkFrom: input.forkFrom })
    )
  }
  return (
    resolveCommittedStructuredAgentSessionAdoptionIntent({ ...input, host }) ??
    prepareStructuredAgentSessionFork({
      ...input,
      host,
      sessionId: input.forkFrom.sessionId,
      throughItemId: input.forkFrom.throughItemId,
      envelope: { ...input.envelope, expectedRuntimeFence: null, payloadFingerprint: '' }
    })
  )
}
