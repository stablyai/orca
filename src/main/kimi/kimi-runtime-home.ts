import { homedir } from 'node:os'
import { join, win32 as pathWin32 } from 'node:path'
import { parseWslUncPath } from '../../shared/wsl-paths'
import {
  resolveLocalAccountRuntimeTarget,
  type LocalAccountRuntimeTarget
} from '../../shared/local-account-runtime'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { getWslHomeAsync, listWslDistrosAsync } from '../wsl'

export type KimiHomeResolution = LocalAccountRuntimeTarget & {
  /** null when the WSL distro's home could not be probed (distro missing/stopped). */
  path: string | null
}

// Why: match the CLI's `KIMI_CODE_HOME ?? ~/.kimi-code` resolution so we read the
// same files the running Kimi CLI writes.
export function getHostKimiHome(): string {
  return process.env.KIMI_CODE_HOME?.trim() || join(homedir(), '.kimi-code')
}

/**
 * Kimi has no per-account runtime switcher, so it follows the local-account
 * runtime policy. WSL is Windows-only — pin everywhere else so no `wsl.exe`
 * probe is attempted on a stale `wsl` setting synced from a Windows machine.
 */
export function getKimiRuntimeTarget(
  settings: GlobalSettings,
  platform: NodeJS.Platform = process.platform
): LocalAccountRuntimeTarget {
  if (platform !== 'win32') {
    return { runtime: 'host', wslDistro: null }
  }
  return resolveLocalAccountRuntimeTarget(settings, platform)
}

/**
 * Resolve a runtime target to the Kimi home Orca should read (UNC path for WSL).
 * Async because it runs on every quota poll: the sync `wsl.exe` probes park
 * Electron's main process for up to 5s each cycle while a distro is stopped.
 */
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
  const home = await getWslHomeAsync(distro)
  // KIMI_CODE_HOME describes the Windows host process, never the distro's home.
  return { runtime: 'wsl', wslDistro: distro, path: home ? joinKimiHome(home) : null }
}

/** Async twin of `getDefaultWslDistro`, which shells out to wsl.exe synchronously. */
async function defaultWslDistro(): Promise<string | null> {
  return (await listWslDistrosAsync())[0] ?? null
}

function joinKimiHome(home: string): string {
  return parseWslUncPath(home) ? pathWin32.join(home, '.kimi-code') : join(home, '.kimi-code')
}
