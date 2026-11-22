import type {
  AgentChatPermissionChoice,
  AgentChatPermissionMode
} from '../../../shared/agent-launch/permissions/agent-chat-permission-mode'
import type { AcpLaunchSpec } from './acp-launch-contract'

/** The session modes a launch reports as Orca's: a full-access launch holds only that mode. */
function acpLaunchPermissionModes(
  spec: Pick<AcpLaunchSpec, 'permissionModeConfig'>,
  fullAccess: boolean
): Readonly<Partial<Record<AgentChatPermissionMode, string>>> | undefined {
  const config = spec.permissionModeConfig
  if (!config?.fullAccessAtLaunch) {
    return config?.values
  }
  const { 'full-access': fullAccessMode, ...others } = config.values
  return fullAccess ? { 'full-access': fullAccessMode } : others
}

export function acpFullAccessForLaunch(
  spec: Pick<AcpLaunchSpec, 'agent' | 'autonomousTools'>,
  choice: AgentChatPermissionChoice | undefined
): boolean {
  if (spec.autonomousTools && choice && choice !== 'own') {
    throw new Error(`${spec.agent} only supports its own tool permissions`)
  }
  return choice === 'full-access'
}

/** A launch's permission facts: Orca's session modes, the starting choice, and whether the agent's
 *  own arguments hold full access, which only a restart can take away. */
export function acpLaunchPermission(
  spec: Pick<AcpLaunchSpec, 'permissionModeConfig' | 'args' | 'autonomousTools'>,
  fullAccess: boolean,
  permission: AgentChatPermissionChoice | undefined
) {
  const args = (grant: boolean) => spec.args({ fullAccess: grant, pluginDirs: [] }).join('\0')
  return {
    permissionModes: acpLaunchPermissionModes(spec, fullAccess),
    permission: permission ?? (spec.autonomousTools ? 'own' : 'ask'),
    launchArgsGrantFullAccess: fullAccess && args(true) !== args(false)
  }
}

/** Whether Orca answers the agent's permission requests itself under full access. */
export function acpAnswersRequests(spec: Pick<AcpLaunchSpec, 'permissionModeConfig'>) {
  return !spec.permissionModeConfig || spec.permissionModeConfig.fullAccessAnswersRequests === true
}
