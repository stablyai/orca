import type { GlobalSettings } from '../../../shared/global-settings-types'

/** Keep configured shell profiles consistent between renderer IPC and runtime-controller spawns. */
export function resolveConfiguredTerminalShellArgs(params: {
  connectionId: string | null | undefined
  requestedShellOverride: string | undefined
  launchCommand: string | undefined
  settings: Pick<GlobalSettings, 'terminalDefaultShell' | 'terminalDefaultShellArgs'> | undefined
}): string[] | undefined {
  const { connectionId, requestedShellOverride, launchCommand, settings } = params
  if (connectionId || requestedShellOverride || launchCommand) {
    return undefined
  }
  const configuredShellArgs = settings?.terminalDefaultShellArgs
  return settings?.terminalDefaultShell?.trim() && configuredShellArgs !== undefined
    ? [...configuredShellArgs]
    : undefined
}
