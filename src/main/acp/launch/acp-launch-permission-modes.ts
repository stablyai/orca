import type {
  AgentChatPermissionChoice,
  AgentChatPermissionMode
} from '../../../shared/agent-launch/permissions/agent-chat-permission-mode'
import type { SessionConfigOption } from '../generated/acp-protocol.generated'
import type { AcpStructuredOptions } from '../options/acp-structured-options'
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

type SelectConfigOption = Extract<SessionConfigOption, { type: 'select' }>

/** Picks the permission mode select option using the same rule for reads and write confirmation. */
export function findAcpPermissionModeSelect(
  configOptions: readonly SessionConfigOption[],
  preferredId?: string
): SelectConfigOption | null {
  const byId = preferredId
    ? configOptions.find(
        (option): option is SelectConfigOption =>
          option.type === 'select' && option.id === preferredId
      )
    : undefined
  if (byId) {
    return byId
  }
  return (
    configOptions.find(
      (option): option is SelectConfigOption =>
        option.type === 'select' && option.category === 'mode'
    ) ?? null
  )
}

/** The config id a permission write targets: the advertised select, else the spec's id. */
export function acpPermissionModeConfigId(
  configOptions: readonly SessionConfigOption[] | null | undefined,
  preferredId?: string
): string {
  return findAcpPermissionModeSelect(configOptions ?? [], preferredId)?.id ?? preferredId ?? 'mode'
}

/** A mode write is confirmed by its echo, or by an empty menu when the agent applies it silently. */
export function confirmAcpPermissionModeWrite(
  mode: { configId?: string; emptyConfigMenuConfirms?: true },
  configId: string,
  requested: string,
  configOptions: readonly SessionConfigOption[],
  options: Pick<
    AcpStructuredOptions,
    'adoptConfigOptions' | 'adoptConfirmedPermissionValue' | 'hasModeSelect' | 'clearPermissionMode'
  >
): void {
  const echoed = findAcpPermissionModeSelect(configOptions, mode.configId ?? configId)
  const acceptsEmptyMenu =
    mode.emptyConfigMenuConfirms === true &&
    !options.hasModeSelect(mode.configId) &&
    mode.configId !== undefined &&
    configId === mode.configId
  const confirmed =
    echoed?.currentValue === requested || (acceptsEmptyMenu && configOptions.length === 0)
  if (!confirmed) {
    if (configOptions.length === 0) {
      options.clearPermissionMode()
    } else {
      options.adoptConfirmedPermissionValue(null)
      options.adoptConfigOptions([...configOptions])
    }
    throw new Error('Permission mode could not be confirmed')
  }
  // A confirmed empty menu applied the mode and listed nothing, so the held menu stays.
  if (configOptions.length > 0) {
    options.adoptConfirmedPermissionValue(null)
    options.adoptConfigOptions([...configOptions])
  } else {
    options.adoptConfirmedPermissionValue(requested)
  }
}

/** Whether Orca answers the agent's permission requests itself under full access. */
export function acpAnswersRequests(spec: Pick<AcpLaunchSpec, 'permissionModeConfig'>) {
  return !spec.permissionModeConfig || spec.permissionModeConfig.fullAccessAnswersRequests === true
}
