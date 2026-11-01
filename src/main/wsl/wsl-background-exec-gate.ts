import {
  assertWslUncPathRunning,
  blockedWslDistroForPath,
  runAsWslUserAct,
  WslDistroUnverifiableError,
  type BlockedWslDistro
} from './wsl-unc-access-gate'
import { isWslUserActFor, runAsWslUserAct as runScopedWslUserAct } from './wsl-user-act-scope'
import {
  resolveWslDefaultDistro,
  runWithWslDefaultDistro,
  UNRESOLVED_WSL_DEFAULT,
  type WslDefaultDistro
} from './wsl-default-distro'

// A user act for a default distro Orca couldn't name; its gated runs pass, nothing else's do.
const UNRESOLVED_DEFAULT_DISTRO = '\u0000unresolved-default'
const DEFAULT_DISTRO_LABEL = 'the default distro'

/** The distro a run in `distro` (null: the default) lands in. */
async function resolveWslExecDistro(distro: string | null | undefined): Promise<WslDefaultDistro> {
  if (process.platform !== 'win32') {
    return null
  }
  return distro?.trim() || resolveWslDefaultDistro()
}

/**
 * Why a background `wsl.exe` run in `distro` (null: the default) must not start now, or null when
 * it may. Any `-d`/`--exec` boots a stopped distro (E9); a user act for that distro passes.
 */
export async function blockedWslDistroForExec(
  distro: string | null | undefined
): Promise<BlockedWslDistro | null> {
  const target = await resolveWslExecDistro(distro)
  if (target === UNRESOLVED_WSL_DEFAULT) {
    // Fails closed: a no-`-d` run boots whatever the default is.
    return isWslUserActFor(UNRESOLVED_DEFAULT_DISTRO)
      ? null
      : { distro: DEFAULT_DISTRO_LABEL, state: 'unverifiable' }
  }
  return target ? blockedWslDistroForPath('', target) : null
}

/** Throws WslDistroStoppedError/WslDistroUnverifiableError when `blockedWslDistroForExec` refuses. */
export async function assertWslDistroRunningForExec(
  distro: string | null | undefined
): Promise<void> {
  const target = await resolveWslExecDistro(distro)
  if (target === UNRESOLVED_WSL_DEFAULT) {
    if (!isWslUserActFor(UNRESOLVED_DEFAULT_DISTRO)) {
      throw new WslDistroUnverifiableError(DEFAULT_DISTRO_LABEL)
    }
    return
  }
  if (target) {
    await assertWslUncPathRunning('', target)
  }
}

/**
 * A terminal launch someone asked for runs as a user act on its distro (null: the default); a
 * passive restore (#35813) or a non-WSL launch runs as-is, so the E9 gates apply to it.
 */
export function runAsWslLaunchUserAct<T>(
  launch: { isWsl: boolean; passiveRestore: boolean; distro: string | null | undefined },
  act: () => Promise<T>
): Promise<T> {
  return launch.isWsl && !launch.passiveRestore
    ? runAsWslExecUserAct(launch.distro ?? null, act)
    : act()
}

/** Runs `act` as a user act on `distro` (null: the default), so its `wsl.exe` runs may start it. */
export async function runAsWslExecUserAct<T>(
  distro: string | null | undefined,
  act: () => Promise<T>
): Promise<T> {
  const target = await resolveWslExecDistro(distro)
  const run = (): Promise<T> =>
    target === UNRESOLVED_WSL_DEFAULT
      ? runScopedWslUserAct(UNRESOLVED_DEFAULT_DISTRO, act)
      : runAsWslUserAct(target, act)
  // An unnamed act pins its default, so gates and the hook relay inside it name the same distro.
  return distro?.trim() ? run() : runWithWslDefaultDistro(target, run)
}
