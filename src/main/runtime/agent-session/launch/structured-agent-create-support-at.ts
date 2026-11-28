import type { AgentSessionExecutionLocation } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import type { StructuredAgentId } from '../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle'
import type { StructuredAgentCreateSupportReply } from '../../../../shared/agent-session/lifecycle/operations/structured-agent-create-support-reply'
import type { AgentCliInstallationProblem } from '../../../../shared/agent-launch/catalog/agent-cli-installation-problem'
import type { resolveHostStructuredAgentCreateSupport } from './structured-agent-launch-support'

/** Whether a new chat of `agent` can start at `location`, in the folder `workspacePath` names.
 *  `requireInstalledChatProgram` is for launches with no chat tab to offer Orca's install. */
export async function structuredAgentCreateSupportAt(
  input: Parameters<typeof resolveHostStructuredAgentCreateSupport>[0] & {
    location: AgentSessionExecutionLocation
    agent: StructuredAgentId
    requireInstalledChatProgram?: boolean
  }
): Promise<StructuredAgentCreateSupportReply & { installation?: AgentCliInstallationProblem }> {
  const { resolveHostStructuredAgentCreateSupport: resolveSupport } =
    await import('./structured-agent-launch-support')
  const support = await resolveSupport(input)
  if (support.supported && input.requireInstalledChatProgram) {
    const { structuredAgentChatProgramNeedsInstall } =
      await import('./structured-agent-availability')
    if (await structuredAgentChatProgramNeedsInstall(input.agent, input.runtime)) {
      return { supported: false, reason: 'chat-program' }
    }
  }
  return support
}
