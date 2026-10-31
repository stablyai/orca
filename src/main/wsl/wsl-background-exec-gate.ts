import { runProcess } from '@orca/process-host'
import {
  lxssRegQuerySpec,
  parseDefaultWslDistroId,
  parseWslDistroRegistrations
} from './wsl-distro-registry-id'
import {
  assertWslUncPathRunning,
  blockedWslDistroForPath,
  runAsWslUserAct,
  WslDistroUnverifiableError,
  type BlockedWslDistro
} from './wsl-unc-access-gate'
import { isWslUserActFor, runAsWslUserAct as runScopedWslUserAct } from './wsl-user-act-scope'

// A user act for a default distro Orca couldn't name; its gated runs pass, nothing else's do.
const UNRESOLVED_DEFAULT_DISTRO = '\u0000unresolved-default'
const DEFAULT_DISTRO_LABEL = 'the default distro'
const UNRESOLVED = Symbol('unresolved default distro')

/** `wsl.exe` with no `-d` runs Lxss's DefaultDistribution, read fresh so a `--set-default` counts. */
async function readDefaultWslDistro(): Promise<{ distro: string | null } | 'unreadable'> {
  try {
    const result = await runProcess(lxssRegQuerySpec())
    if (result.code !== 0) {
      return 'unreadable'
    }
    const registrations = parseWslDistroRegistrations(result.stdout)
    if (registrations.length === 0) {
      // No distro registered: wsl.exe has nothing to start.
      return { distro: null }
    }
    const defaultId = parseDefaultWslDistroId(result.stdout)
    const match = registrations.find(({ id }) => id === defaultId)
    return match ? { distro: match.distro } : 'unreadable'
  } catch {
    return 'unreadable'
  }
}

/** The distro a run in `distro` (null: the default) lands in; UNRESOLVED when WSL can't say. */
async function resolveWslExecDistro(
  distro: string | null | undefined
): Promise<string | null | typeof UNRESOLVED> {
  if (process.platform !== 'win32') {
    return null
  }
  const named = distro?.trim()
  if (named) {
    return named
  }
  const resolved = await readDefaultWslDistro()
  return resolved === 'unreadable' ? UNRESOLVED : resolved.distro
}

/**
 * Why a background `wsl.exe` run in `distro` (null: the default) must not start now, or null when
 * it may. Any `-d`/`--exec` boots a stopped distro (E9); a user act for that distro passes.
 */
export async function blockedWslDistroForExec(
  distro: string | null | undefined
): Promise<BlockedWslDistro | null> {
  const target = await resolveWslExecDistro(distro)
  if (target === UNRESOLVED) {
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
  if (target === UNRESOLVED) {
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
  return target === UNRESOLVED
    ? runScopedWslUserAct(UNRESOLVED_DEFAULT_DISTRO, act)
    : runAsWslUserAct(target, act)
}
