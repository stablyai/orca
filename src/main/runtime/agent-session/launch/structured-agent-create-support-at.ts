import type { AgentSessionExecutionLocation } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import type { StructuredAgentId } from '../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle'
import type { StructuredAgentCreateSupportReply } from '../../../../shared/agent-session/lifecycle/operations/structured-agent-create-support-reply'
import type { AgentCliInstallationProblem } from '../../../../shared/agent-launch/catalog/agent-cli-installation-problem'
import { resolveHostStructuredAgentCreateSupport } from './structured-agent-launch-support'
import { structuredAgentChatProgramNeedsInstall } from './structured-agent-availability'

/** Whether a new chat of `agent` can start at `location`, in the folder `workspacePath` names.
 *  `requireInstalledChatProgram` is for launches with no chat tab to offer Orca's install. */
export async function structuredAgentCreateSupportAt(
  input: Parameters<typeof resolveHostStructuredAgentCreateSupport>[0] & {
    location: AgentSessionExecutionLocation
    agent: StructuredAgentId
    requireInstalledChatProgram?: boolean
  }
): Promise<StructuredAgentCreateSupportReply & { installation?: AgentCliInstallationProblem }> {
  const support = await resolveHostStructuredAgentCreateSupport(input)
  if (
    support.supported &&
    input.requireInstalledChatProgram &&
    (await structuredAgentChatProgramNeedsInstall(input.agent, input.runtime))
  ) {
    return { supported: false, reason: 'chat-program' }
  }
  return support
}
