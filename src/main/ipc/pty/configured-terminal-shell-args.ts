import type { GlobalSettings } from '../../../shared/global-settings-types'

/** Why: two spawn paths (renderer IPC and runtime controller) must agree, or the
 *  configured profile silently applies to only one of them. */
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
