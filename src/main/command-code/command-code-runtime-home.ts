import { homedir } from 'node:os'
import { join, win32 as pathWin32 } from 'node:path'
import { parseWslUncPath } from '../../shared/wsl-paths'
import {
  resolveLocalAccountRuntimeTarget,
  type LocalAccountRuntimeTarget
} from '../../shared/local-account-runtime'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { getWslHomeAsync, listWslDistrosAsync } from '../wsl'
import { isWslDistroRunning } from '../wsl-background-distro-gate'

export type CommandCodeHomeResolution = LocalAccountRuntimeTarget & {
  /** The CLI's `.commandcode` directory; null when the distro is missing or stopped. */
  path: string | null
}

export function getHostCommandCodeHome(): string {
  return join(homedir(), '.commandcode')
}

/**
 * Command Code has no per-account runtime switcher, so it follows the
 * local-account runtime policy. WSL is Windows-only — pin everywhere else so no
 * `wsl.exe` probe is attempted on a stale `wsl` setting synced from Windows.
 */
export function getCommandCodeRuntimeTarget(
  settings: GlobalSettings,
  platform: NodeJS.Platform = process.platform
): LocalAccountRuntimeTarget {
  if (platform !== 'win32') {
    return { runtime: 'host', wslDistro: null }
  }
  return resolveLocalAccountRuntimeTarget(settings, platform)
}

/**
 * Resolve a runtime target to the `.commandcode` directory Orca should read
 * (UNC path for WSL). Async because it runs on every quota poll: the sync
 * `wsl.exe` probes park Electron's main process for up to 5s each cycle while a
 * distro is stopped.
 */
export async function resolveCommandCodeHome(
  target: LocalAccountRuntimeTarget,
  platform: NodeJS.Platform = process.platform
): Promise<CommandCodeHomeResolution> {
  if (target.runtime !== 'wsl' || platform !== 'win32') {
    return { runtime: 'host', wslDistro: null, path: getHostCommandCodeHome() }
  }
  const distro = target.wslDistro?.trim() || (await defaultWslDistro())
  if (!distro) {
    return { runtime: 'wsl', wslDistro: null, path: null }
  }
  // Why: a quota poll is background work and must not boot a stopped distro.
  if (!(await isWslDistroRunning(distro))) {
    return { runtime: 'wsl', wslDistro: distro, path: null }
  }
  const home = await getWslHomeAsync(distro)
  return { runtime: 'wsl', wslDistro: distro, path: home ? joinCommandCodeHome(home) : null }
}

/** Async twin of `getDefaultWslDistro`, which shells out to wsl.exe synchronously. */
async function defaultWslDistro(): Promise<string | null> {
  return (await listWslDistrosAsync())[0] ?? null
}

function joinCommandCodeHome(home: string): string {
  return parseWslUncPath(home) ? pathWin32.join(home, '.commandcode') : join(home, '.commandcode')
}
