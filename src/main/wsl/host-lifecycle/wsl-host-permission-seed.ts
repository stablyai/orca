/** A new WSL host starts with this desktop's agent permission, not the product default. */
import { AGENT_LAUNCH_PERMISSION_CHOICE_CAPABILITY } from '../../../shared/agent-launch/contracts/agent-launch-runtime-capability'
import type { AgentLaunchSettingsMutation } from '../../../shared/agent-launch/choices/agent-launch-settings'
import {
  isAgentPermissionChoice,
  type AgentPermissionChoice
} from '../../../shared/agent-launch/permissions/tui-agent-permission-choice'
import { isTuiAgent } from '../../../shared/agent-launch/catalog/tui-agent-config'
import type { TuiAgent } from '../../../shared/agent-launch/catalog/tui-agent'
import type { RuntimeRpcResponse } from '../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import type { WslOrcadHostCapabilityVerdict } from '../orcad/wsl-orcad-host-environments'

const PRODUCT_DEFAULT: AgentPermissionChoice = 'full-access'

type HostPermission = {
  default: AgentPermissionChoice
  overrides: Partial<Record<TuiAgent, AgentPermissionChoice>>
}

export type WslHostPermissionSeed = {
  local: {
    agentPermissionDefault?: AgentPermissionChoice
    agentPermissionOverrides?: Partial<Record<TuiAgent, AgentPermissionChoice>>
  }
  hostSupports: (capability: string) => Promise<WslOrcadHostCapabilityVerdict>
  call: (method: string, params: unknown) => Promise<RuntimeRpcResponse<unknown>>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readHostPermission(result: unknown): HostPermission | null {
  const permission =
    isRecord(result) && isRecord(result.settings) ? result.settings.agentPermission : undefined
  if (!isRecord(permission) || !isAgentPermissionChoice(permission.default)) {
    return null
  }
  const overrides: Partial<Record<TuiAgent, AgentPermissionChoice>> = {}
  for (const [agent, choice] of Object.entries(
    isRecord(permission.overrides) ? permission.overrides : {}
  )) {
    if (isTuiAgent(agent) && isAgentPermissionChoice(choice)) {
      overrides[agent] = choice
    }
  }
  return { default: permission.default, overrides }
}

async function callOk(seed: WslHostPermissionSeed, method: string, params: unknown) {
  const response = await seed.call(method, params)
  if (!response.ok) {
    throw new Error(response.error.message)
  }
  return response.result
}

/**
 * Copies the local all-agents and per-agent choices onto a host still at the product default.
 * A host someone already configured keeps its own choice. Returns whether anything was written.
 */
export async function seedWslHostAgentPermission(seed: WslHostPermissionSeed): Promise<boolean> {
  const localDefault = seed.local.agentPermissionDefault ?? PRODUCT_DEFAULT
  const localOverrides = Object.entries(seed.local.agentPermissionOverrides ?? {}).filter(
    (entry): entry is [TuiAgent, AgentPermissionChoice] =>
      isTuiAgent(entry[0]) && isAgentPermissionChoice(entry[1])
  )
  if (localDefault === PRODUCT_DEFAULT && localOverrides.length === 0) {
    return false
  }
  // Older hosts store permissions as launch text; Settings still lets the user change them there.
  if ((await seed.hostSupports(AGENT_LAUNCH_PERMISSION_CHOICE_CAPABILITY)) !== 'supported') {
    return false
  }
  const host = readHostPermission(await callOk(seed, 'settings.getAgentLaunch', undefined))
  if (!host || host.default !== PRODUCT_DEFAULT || Object.keys(host.overrides).length > 0) {
    return false
  }
  const mutations: AgentLaunchSettingsMutation[] = [
    ...(localDefault === PRODUCT_DEFAULT
      ? []
      : [{ type: 'permission' as const, choice: localDefault }]),
    ...localOverrides.map(([agent, choice]) => ({ type: 'permission' as const, choice, agent }))
  ]
  for (const mutation of mutations) {
    await callOk(seed, 'settings.mutateAgentLaunch', mutation)
  }
  return true
}
