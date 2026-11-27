import { STRUCTURED_AGENT_RUNTIME_METADATA } from '../runtime/agent-session/installation/structured-agent-runtime-metadata'
import type { TuiAgent } from '../../shared/agent-launch/catalog/tui-agent'
import type { StructuredAgentCreateSupportReply } from '../../shared/agent-session/lifecycle/operations/structured-agent-create-support-reply'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'

export const REGISTERED_STRUCTURED_AGENTS: readonly string[] =
  STRUCTURED_AGENT_RUNTIME_METADATA.map(({ definition }) => definition.agent)

/** Where a launch's chat support is read: its workspace, or the repo a workspace is about to be
 *  created in, which runs where the repo does. */
export type AgentLaunchSupportPlace = { worktreeId: string } | { repoSelector: string }

export type CreateSupportRuntime = Pick<
  OrcaRuntimeService,
  'getStructuredAgentSessionCreateSupport'
>

/** Unknown host support must fall back to a terminal. */
export async function readStructuredCreateSupport(
  runtime: CreateSupportRuntime,
  place: AgentLaunchSupportPlace,
  agent: TuiAgent | undefined
): Promise<StructuredAgentCreateSupportReply | null> {
  if (!agent || !REGISTERED_STRUCTURED_AGENTS.includes(agent)) {
    return { supported: false, reason: 'agent' }
  }
  // These launches have no chat tab to offer the install, so they keep the agent's own CLI.
  const options = { requireInstalledChatProgram: true }
  try {
    return await runtime.getStructuredAgentSessionCreateSupport(
      'worktreeId' in place ? `id:${place.worktreeId}` : { repo: place.repoSelector },
      agent,
      options
    )
  } catch {
    return null
  }
}
