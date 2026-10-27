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

export type KimiHomeResolution = LocalAccountRuntimeTarget & {
  /** null when the distro is missing or stopped, or its home could not be probed. */
  path: string | null
}

// Match CLI KIMI_CODE_HOME resolution.
export function getHostKimiHome(): string {
  return process.env.KIMI_CODE_HOME?.trim() || join(homedir(), '.kimi-code')
}

/** Kimi follows local-account runtime policy; ignore synced WSL settings outside Windows. */
export function getKimiRuntimeTarget(
  settings: GlobalSettings,
  platform: NodeJS.Platform = process.platform
): LocalAccountRuntimeTarget {
  if (platform !== 'win32') {
    return { runtime: 'host', wslDistro: null }
  }
  return resolveLocalAccountRuntimeTarget(settings, platform)
}

/** Use async WSL probes on quota polls to avoid blocking Electron; WSL paths are UNC. */
export async function resolveKimiHome(
  target: LocalAccountRuntimeTarget,
  platform: NodeJS.Platform = process.platform
): Promise<KimiHomeResolution> {
  if (target.runtime !== 'wsl' || platform !== 'win32') {
    return { runtime: 'host', wslDistro: null, path: getHostKimiHome() }
  }
  const distro = target.wslDistro?.trim() || (await defaultWslDistro())
  if (!distro) {
    return { runtime: 'wsl', wslDistro: null, path: null }
  }
  // Background quota polling must not start stopped distros.
  if (!(await isWslDistroRunning(distro))) {
    return { runtime: 'wsl', wslDistro: distro, path: null }
  }
  const home = await getWslHomeAsync(distro)
  // KIMI_CODE_HOME describes the Windows host process, never the distro's home.
  return { runtime: 'wsl', wslDistro: distro, path: home ? joinKimiHome(home) : null }
}

async function defaultWslDistro(): Promise<string | null> {
  return (await listWslDistrosAsync())[0] ?? null
}

function joinKimiHome(home: string): string {
  return parseWslUncPath(home) ? pathWin32.join(home, '.kimi-code') : join(home, '.kimi-code')
}
