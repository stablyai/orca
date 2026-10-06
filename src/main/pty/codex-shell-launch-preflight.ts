import { accessSync, constants, statSync } from 'node:fs'
import { getBundledLauncherPath } from '../cli/bundled-cli-launcher-path'

export type CodexShellLaunchPreflightCommandOptions = {
  hooksEnabled: boolean
  isPackaged: boolean
  isWsl?: boolean
  managedHomePath: string | null
  /** Packaged app resources root; the bundled launcher lives under it. */
  resourcesPath?: string | null
  /** Test seam. */
  platform?: NodeJS.Platform
}

/** Absolute path of the Orca CLI the preflight must execute, or null to skip it.
 *  Only a WSL pane gets one: the app prepares every native Codex home itself.
 *
 *  Why absolute: the value rides in ORCA_CODEX_LAUNCH_PREFLIGHT and is invoked
 *  from the codex() wrapper, which shell-ready emits *after* the user's profile
 *  scripts run. Those scripts routinely rewrite PATH, so an unqualified name
 *  would be resolved against a PATH Orca neither controls nor can predict —
 *  handing Orca's managed Codex environment to an unidentified program. When no
 *  path verifies, skipping the preflight is the predictable degradation. */
export function resolveCodexShellLaunchPreflightCommand(
  options: CodexShellLaunchPreflightCommandOptions
): string | null {
  const platform = options.platform ?? process.platform
  // Why: WSLENV /p translates the verified Windows launcher with the distro's configured automount root.
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
    // Why: Windows has no exec bit, so a readable launcher file is the strongest signal available.
    accessSync(path, platform === 'win32' ? constants.R_OK : constants.X_OK)
    return true
  } catch {
    return false
  }
}
