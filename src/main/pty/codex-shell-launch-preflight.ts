import { accessSync, constants, statSync } from 'node:fs'
import { getBundledLauncherPath } from '../cli/bundled-cli-launcher-path'

export type CodexShellLaunchPreflightCommandOptions = {
  hooksEnabled: boolean
  isPackaged: boolean
  isWsl?: boolean
  managedHomePath: string | null
  /** Packaged app resources root; the bundled launcher lives under it. */
  resourcesPath?: string | null
  platform?: NodeJS.Platform
}

/** Verified absolute WSL preflight launcher; native homes are prepared by the app.
 * User profiles rewrite PATH before the wrapper runs, so bare names could expose managed state to another program. */
export function resolveCodexShellLaunchPreflightCommand(
  options: CodexShellLaunchPreflightCommandOptions
): string | null {
  const platform = options.platform ?? process.platform
  // WSLENV /p translates this host launcher using the distro's configured automount root.
  if (
    !options.hooksEnabled ||
    !options.managedHomePath ||
    !options.isWsl ||
    !options.isPackaged ||
    platform !== 'win32' ||
    !options.resourcesPath
  ) {
    return null
  }
  const candidate = getBundledLauncherPath(platform, options.resourcesPath)
  return candidate && isExecutableFileOnDisk(candidate, platform) ? candidate : null
}

function isExecutableFileOnDisk(path: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(path).isFile()) {
      return false
    }
    // Windows has no exec bit; verify readability instead.
    accessSync(path, platform === 'win32' ? constants.R_OK : constants.X_OK)
    return true
  } catch {
    return false
  }
}
