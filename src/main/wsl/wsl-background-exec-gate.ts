import { listWslDistrosAsync } from '../wsl'
import {
  assertWslUncPathRunning,
  blockedWslDistroForPath,
  runAsWslUserAct,
  type BlockedWslDistro
} from './wsl-unc-access-gate'

// `wsl.exe` with no `-d` runs the default distro, which `--list --quiet` names first.
async function resolveWslExecDistro(distro: string | null | undefined): Promise<string | null> {
  if (process.platform !== 'win32') {
    return null
  }
  return distro?.trim() || ((await listWslDistrosAsync())[0] ?? null)
}

/**
 * Why a background `wsl.exe` run in `distro` (null: the default) must not start now, or null when
 * it may. Any `-d`/`--exec` boots a stopped distro (E9); a user act for that distro passes.
 */
export async function blockedWslDistroForExec(
  distro: string | null | undefined
): Promise<BlockedWslDistro | null> {
  const target = await resolveWslExecDistro(distro)
  // No distro named and none listed: wsl.exe has nothing to start.
  return target ? blockedWslDistroForPath('', target) : null
}

/** Throws WslDistroStoppedError/WslDistroUnverifiableError when `blockedWslDistroForExec` refuses. */
export async function assertWslDistroRunningForExec(
  distro: string | null | undefined
): Promise<void> {
  const target = await resolveWslExecDistro(distro)
  if (target) {
    await assertWslUncPathRunning('', target)
  }
}

/** Runs `act` as a user act on `distro` (null: the default), so its `wsl.exe` runs may start it. */
export async function runAsWslExecUserAct<T>(
  distro: string | null | undefined,
  act: () => Promise<T>
): Promise<T> {
  return runAsWslUserAct(await resolveWslExecDistro(distro), act)
}
