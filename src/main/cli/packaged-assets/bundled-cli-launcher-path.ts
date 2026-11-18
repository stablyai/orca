import { join } from 'node:path'
import { ZOTZ_CLI_COMMAND } from '../../../shared/zotz/zotz-app-identity'

// Why `orca-ide` on Linux: GNOME Orca ships /usr/bin/orca, so the CLI never claims that name.
export const LINUX_CLI_COMMAND_NAME = 'orca-ide'

// Keep path-only callers independent of cli-installer's Electron dependency.
export function getBundledLauncherPath(
  platform: NodeJS.Platform,
  resourcesPath: string
): string | null {
  if (platform === 'darwin') {
    return join(resourcesPath, 'bin', ZOTZ_CLI_COMMAND)
  }
  if (platform === 'linux') {
    return join(resourcesPath, 'bin', LINUX_CLI_COMMAND_NAME)
  }
  if (platform === 'win32') {
    return join(resourcesPath, 'bin', `${ZOTZ_CLI_COMMAND}.exe`)
  }
  return null
}

/** Windows keeps `orca` out of the PATH-registered bin dir; only Zotz's own children see this folder. */
export function getOrcaCompatLauncherDir(resourcesPath: string): string {
  return join(resourcesPath, 'orca-compat')
}
