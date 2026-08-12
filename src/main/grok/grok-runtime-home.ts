import { join, win32 as pathWin32 } from 'node:path'
import { resolveGrokHomeDir } from '../../shared/grok-session-paths'
import { parseWslUncPath } from '../../shared/wsl-paths'
import {
  resolveLocalAccountRuntimeTarget,
  type LocalAccountRuntimeTarget
} from '../../shared/local-account-runtime'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { getWslHomeAsync, listWslDistrosAsync } from '../wsl'

export type GrokHomeResolution = LocalAccountRuntimeTarget & {
  /** null when the WSL distro's home could not be probed. */
  path: string | null
}

export type GrokHomeResolver = (target: LocalAccountRuntimeTarget) => Promise<GrokHomeResolution>

/** Match Grok CLI's `GROK_HOME ?? ~/.grok` resolution on the host. */
export function getHostGrokHome(): string {
  return resolveGrokHomeDir()
}

/** Grok follows the local-account runtime policy on Windows. */
export function getGrokRuntimeTarget(
  settings: GlobalSettings,
  platform: NodeJS.Platform = process.platform
): LocalAccountRuntimeTarget {
  if (platform !== 'win32') {
    return { runtime: 'host', wslDistro: null }
  }
  return resolveLocalAccountRuntimeTarget(settings, platform)
}

/** Resolve the Grok home Orca should read, using a UNC path for WSL. */
export async function resolveGrokHome(
  target: LocalAccountRuntimeTarget,
  platform: NodeJS.Platform = process.platform
): Promise<GrokHomeResolution> {
  if (target.runtime !== 'wsl' || platform !== 'win32') {
    return { runtime: 'host', wslDistro: null, path: getHostGrokHome() }
  }
  const distro = target.wslDistro?.trim() || (await listWslDistrosAsync())[0] || null
  if (!distro) {
    return { runtime: 'wsl', wslDistro: null, path: null }
  }
  const home = await getWslHomeAsync(distro)
  return {
    runtime: 'wsl',
    wslDistro: distro,
    path: home ? joinGrokHome(home) : null
  }
}

/** Append Grok CLI's data directory without breaking WSL UNC semantics. */
function joinGrokHome(home: string): string {
  return parseWslUncPath(home) ? pathWin32.join(home, '.grok') : join(home, '.grok')
}
