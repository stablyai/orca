import { join } from 'node:path'

// Why `mcode-ide` on Linux: GNOME MCode ships /usr/bin/mcode, so the CLI never claims that name.
export const LINUX_CLI_COMMAND_NAME = 'mcode-ide'

/** Absolute path of the CLI launcher this app ships in its own resources bundle.
 *  Lives apart from cli-installer so callers that only need the path (PTY env
 *  assembly) don't pull in the installer's `electron` dependency. */
export function getBundledLauncherPath(
  platform: NodeJS.Platform,
  resourcesPath: string
): string | null {
  if (platform === 'darwin') {
    return join(resourcesPath, 'bin', 'mcode')
  }
  if (platform === 'linux') {
    return join(resourcesPath, 'bin', LINUX_CLI_COMMAND_NAME)
  }
  if (platform === 'win32') {
    return join(resourcesPath, 'bin', 'mcode.exe')
  }
  return null
}
