import type { TuiAgent } from '../../shared/agent-launch/catalog/tui-agent'
import type { StructuredAgentCreateSupportReply } from '../../shared/agent-session/lifecycle/operations/structured-agent-create-support-reply'
import { STRUCTURED_AGENT_RUNTIME_METADATA } from '../runtime/agent-session/installation/structured-agent-runtime-metadata'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'

export const REGISTERED_STRUCTURED_AGENTS: readonly string[] =
  STRUCTURED_AGENT_RUNTIME_METADATA.map(({ definition }) => definition.agent)

/** Unknown host support must fall back to a terminal. */
export async function readStructuredCreateSupport(
  runtime: Pick<OrcaRuntimeService, 'getStructuredAgentSessionCreateSupport'>,
  worktreeId: string,
  agent: TuiAgent | undefined
): Promise<StructuredAgentCreateSupportReply | null> {
  if (!agent || !REGISTERED_STRUCTURED_AGENTS.includes(agent)) {
    return { supported: false, reason: 'agent' }
  }
  try {
    // These launches have no chat tab to offer the install, so they keep the agent's own CLI.
    return await runtime.getStructuredAgentSessionCreateSupport(`id:${worktreeId}`, agent, {
      requireInstalledChatProgram: true
    })
  } catch {
    return null
  }
}
