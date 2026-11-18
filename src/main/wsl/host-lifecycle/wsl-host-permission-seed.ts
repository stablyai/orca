/** A new WSL host starts with this desktop's agent permission, not the product default. */
import { AGENT_LAUNCH_PERMISSION_SEED_CAPABILITY } from '../../../shared/agent-launch/contracts/agent-launch-runtime-capability'
import type { AgentLaunchSettingsMutation } from '../../../shared/agent-launch/choices/agent-launch-settings'
import {
  isAgentPermissionChoice,
  normalizeAgentPermissionOverrides,
  type AgentPermissionGlobalSettings
} from '../../../shared/agent-launch/permissions/tui-agent-permission-choice'
import type { RuntimeRpcResponse } from '../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import type { WslOrcadHostCapabilityVerdict } from '../orcad/wsl-orcad-host-environments'

export type WslHostPermissionSeed = {
  local: AgentPermissionGlobalSettings
  hostSupports: (capability: string) => Promise<WslOrcadHostCapabilityVerdict>
  call: (method: string, params: unknown) => Promise<RuntimeRpcResponse<unknown>>
}

/**
 * Asks the host to take the local all-agents and per-agent choices. The host applies them only
 * while it is still at the product default, inside its own write, so a choice made there first wins.
 * Returns whether the request was sent.
 */
export async function seedWslHostAgentPermission(seed: WslHostPermissionSeed): Promise<boolean> {
  const choice = isAgentPermissionChoice(seed.local.agentPermissionDefault)
    ? seed.local.agentPermissionDefault
    : 'full-access'
  const overrides = normalizeAgentPermissionOverrides(seed.local.agentPermissionOverrides)
  if (choice === 'full-access' && Object.keys(overrides).length === 0) {
    return false
  }
  // Older hosts have no conditional write; an unconditional one could undo a choice made meanwhile.
  if ((await seed.hostSupports(AGENT_LAUNCH_PERMISSION_SEED_CAPABILITY)) !== 'supported') {
    return false
  }
  const mutation: AgentLaunchSettingsMutation = { type: 'seed-permission', choice, overrides }
  const response = await seed.call('settings.mutateAgentLaunch', mutation)
  if (!response.ok) {
    throw new Error(response.error.message)
  }
  return true
}
