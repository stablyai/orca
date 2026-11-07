import type { AgentChatPermissionMode } from '../../shared/agent-launch/permissions/agent-chat-permission-mode'
import type { AcpLaunchSpec } from './acp-launch-specs'

/** The session modes a launch reports as Orca's: a full-access launch holds only that mode. */
export function acpLaunchPermissionModes(
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
