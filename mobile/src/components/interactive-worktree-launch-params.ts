import type { TuiAgent } from '../../../src/shared/types'
import { isCustomTuiAgentId } from '../../../src/shared/custom-tui-agent-identity'
import type {
  AgentLaunchSelectionRequest,
  AgentLaunchSpawnRequest
} from '../../../src/shared/agent-launch-spawn-request'

export type InteractiveLaunchParamsInput = {
  selectedAgentId: TuiAgent | '__blank__'
  hasIdentityCapability: boolean
  // When true (and not blank), defer the agent choice to the host's stored default
  // instead of pinning the client-previewed agent — host-atomic auto-pick. Set when
  // the user has not overridden the auto-selected agent. Ignored on the legacy path,
  // which has no default selection and always sends the concrete preview id.
  deferToHostDefault: boolean
  // Legacy client-assembled command (agentCmdOverrides[id] ?? MOBILE_TUI_AGENT_LAUNCH_COMMANDS[id]).
  // Sent only to hosts without the identity capability, kept one release.
  legacyCommand: string | undefined
}

// Why: identity-only host launch (U7). Capable hosts receive the agent identity in
// `agentLaunch` and derive the command + env themselves; the host IGNORES
// startupCommand/createdWithAgent when agentLaunch is present, and it is the only
// field admitting a custom agent id. Older hosts keep the legacy client-assembled
// startupCommand for one release. A blank terminal launches no agent.
export function buildInteractiveLaunchParams(
  input: InteractiveLaunchParamsInput
): Record<string, unknown> {
  const { selectedAgentId, hasIdentityCapability, deferToHostDefault, legacyCommand } = input
  if (selectedAgentId === '__blank__') {
    return {}
  }
  if (hasIdentityCapability) {
    const selection: AgentLaunchSelectionRequest = deferToHostDefault
      ? { kind: 'default' }
      : { kind: 'agent', agent: selectedAgentId }
    // allowEmptyPromptLaunch: a new workspace launches a bare TUI with no prompt,
    // and without it the host's plan builder returns null and fails
    // no_agent_selected — which aborts the whole worktree create.
    const agentLaunch: AgentLaunchSpawnRequest = { selection, allowEmptyPromptLaunch: true }
    return { agentLaunch }
  }
  if (isCustomTuiAgentId(selectedAgentId)) {
    // Why: only agentLaunch admits a custom id, and the picker shows customs only
    // for catalog-capable hosts — reaching here means the submit-time capability
    // probe failed transiently. Fail visibly instead of silently downgrading the
    // launch to a blank terminal.
    throw new Error(
      'Could not confirm this host supports custom agents. Check the connection and try again.'
    )
  }
  return {
    ...(legacyCommand !== undefined ? { startupCommand: legacyCommand } : {}),
    createdWithAgent: selectedAgentId
  }
}
