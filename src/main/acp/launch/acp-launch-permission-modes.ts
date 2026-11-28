import type {
  AgentChatPermissionChoice,
  AgentChatPermissionMode
} from '../../../shared/agent-launch/permissions/agent-chat-permission-mode'
import type { AcpLaunchSpec } from './acp-launch-contract'
import type { SessionConfigOption } from '../generated/acp-protocol.generated'
import { acpSelectChoices } from '../options/acp-select-choices'
import { AgentSessionAcquisitionRefusal } from '../../native-chat/agent-session-wire/providers/structured-agent-session-adapter-errors'

/** Some AGY accounts and hosts omit Auto from their session's mode selector. */
export function assertAntigravityAutoOffered(
  options: readonly SessionConfigOption[],
  configId: string,
  requested: string
): void {
  const selector = options.find((option) => option.id === configId)
  if (
    selector?.type === 'select' &&
    !acpSelectChoices(selector).some((item) => item.value === requested)
  ) {
    throw new AgentSessionAcquisitionRefusal(
      `Antigravity did not offer ${requested}`,
      'autoPermissionUnavailable'
    )
  }
}

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

/** A launch's permission facts: Orca's session modes, the starting choice, and whether the agent's
 *  own arguments hold full access, which only a restart can take away. */
export function acpLaunchPermission(
  spec: Pick<AcpLaunchSpec, 'permissionModeConfig' | 'args'>,
  fullAccess: boolean,
  permission: AgentChatPermissionChoice | undefined
) {
  const args = (grant: boolean) => spec.args({ fullAccess: grant, pluginDirs: [] }).join('\0')
  return {
    permissionModes: acpLaunchPermissionModes(spec, fullAccess),
    permission: permission ?? 'ask',
    launchArgsGrantFullAccess: fullAccess && args(true) !== args(false)
  }
}

/** Whether Orca answers the agent's permission requests itself under full access. */
export function acpAnswersRequests(spec: Pick<AcpLaunchSpec, 'permissionModeConfig'>) {
  return !spec.permissionModeConfig || spec.permissionModeConfig.fullAccessAnswersRequests === true
}
