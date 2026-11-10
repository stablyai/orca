import { prepareStructuredAgentSessionFork } from './structured-agent-session-fork'
import { resolveCommittedStructuredAgentSessionAdoptionIntent } from '../../../runtime/agent-session/structured-agent-session-create-adoption'
import { agentConversationCopyRefusal } from '../../agent-conversation-copy-error'
import { acpAgentName } from '../../../acp/session/acp-structured-agent-definitions'
import type { AgentSessionExecutionLocation } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import type { StructuredAgentId } from '../../../../shared/agent-session/lifecycle/agent-session-provider-handle'
import type { StructuredAgentSessionHost } from '../host/structured-agent-session-host'
import type { AgentSessionAttachParams } from './structured-agent-session-attach'

export async function resolveStructuredAgentSessionForkIntent(input: {
  host: StructuredAgentSessionHost | null
  forkFrom: { sessionId: string; throughItemId: string }
  agent: StructuredAgentId
  location: AgentSessionExecutionLocation
  envelope: { sessionId: string; clientOperationId: string }
  callerKey?: string
}): Promise<AgentSessionAttachParams> {
  const { host } = input
  if (!host) {
    throw agentConversationCopyRefusal(
      'structured_agent_session_unsupported',
      { reason: 'hostUnsupported' },
      `${acpAgentName(input.agent)} could not reach the execution host. Reconnect to the host, then try again.`
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
