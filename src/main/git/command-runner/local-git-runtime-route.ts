/**
 * Every local Git call follows its project's runtime, not only the callers that remember to pass
 * it: a `C:\` project whose runtime is WSL runs WSL Git unless it chose Git for Windows. Mixing the
 * two on one checkout is what lets one Git prune the other's worktrees (risk R36). A UNC cwd already
 * names its distro; a caller that must run the host's Git anyway says so with `hostGit: true`.
 */
import { isWslDistroNotFoundFailure } from '../../wsl/wsl-distro-unsupported'
import type { GitAdmissionTier } from './git-exec-options'

type RoutableGitOptions = {
  cwd: string
  wslDistro?: string
  /** Runs the host's Git even in a WSL-runtime project; the call site says why. */
  hostGit?: true
}

/** The distro a local folder's project runs Git in, or undefined for the host's Git. */
export type LocalGitRuntimeRouter = (cwd: string) => string | undefined

let router: LocalGitRuntimeRouter | null = null
let isDistroRunning: ((distro: string) => Promise<boolean>) | null = null

/** Main installs the store-backed router once the profile loads; null in tests and other hosts. */
export function setLocalGitRuntimeRouter(next: LocalGitRuntimeRouter | null): void {
  router = next
}

/** Background Git on a WSL `C:\` project waits for its distro instead of booting it. */
export function setBackgroundWslGitGate(next: ((distro: string) => Promise<boolean>) | null): void {
  isDistroRunning = next
}

/** True with the D1c router on, so callers can pick routing-aware paths only then. */
export function isLocalGitRuntimeRouterInstalled(): boolean {
  return router !== null
}

const WINDOWS_DRIVE_PATH = /^[A-Za-z]:[\\/]/

export function routeLocalGitOptions<T extends RoutableGitOptions>(options: T): T {
  if (
    !router ||
    process.platform !== 'win32' ||
    options.wslDistro ||
    options.hostGit ||
    !WINDOWS_DRIVE_PATH.test(options.cwd)
  ) {
    return options
  }
  const wslDistro = router(options.cwd)
  return wslDistro ? { ...options, wslDistro } : options
}

export class WslGitSkippedError extends Error {
  constructor(
    readonly distro: string,
    readonly reason: 'distro-missing' | 'distro-stopped'
  ) {
    super(
      reason === 'distro-missing'
        ? `WSL distro ${distro} is not installed, so its Git can't run.`
        : `WSL distro ${distro} is stopped; background Git waits until it runs.`
    )
    this.name = 'WslGitSkippedError'
  }
}

// Long enough that a poller's next ticks fail fast, short enough to notice a reinstall.
const MISSING_DISTRO_TTL_MS = 30_000
const missingUntil = new Map<string, number>()

function distroKey(distro: string): string {
  return distro.trim().toLowerCase()
}

/**
 * The checks before a WSL Git call starts, or null when there are none: a distro WSL just said is
 * missing fails at once rather than spawning wsl.exe again, and background Git on a Windows-drive
 * project never boots a stopped distro.
 */
export function admitWslGit(
  options: RoutableGitOptions & { admissionTier?: GitAdmissionTier },
  now: number = Date.now()
): Promise<void> | null {
  const distro = options.wslDistro
  // Only with the router installed (D1c); otherwise every call runs exactly as before it.
  if (!distro || !router) {
    return null
  }
  const until = missingUntil.get(distroKey(distro))
  if (until !== undefined && until > now) {
    return Promise.reject(new WslGitSkippedError(distro, 'distro-missing'))
  }
  if (
    options.admissionTier !== 'background' ||
    !isDistroRunning ||
    !WINDOWS_DRIVE_PATH.test(options.cwd)
  ) {
    return null
  }
  return isDistroRunning(distro).then((running) => {
    if (!running) {
      throw new WslGitSkippedError(distro, 'distro-stopped')
    }
  })
}

/** Records a WSL Git failure that says the distro is gone; any other failure is left alone. */
export function noteWslGitFailure(
  options: Pick<RoutableGitOptions, 'wslDistro'>,
  error: unknown,
  now: number = Date.now()
): void {
  if (router && options.wslDistro && isWslDistroNotFoundFailure(error)) {
    missingUntil.set(distroKey(options.wslDistro), now + MISSING_DISTRO_TTL_MS)
  }
}

/** `run` after admitWslGit, recording a missing distro when WSL reports one. */
export function runAdmittedWslGit<T>(
  options: RoutableGitOptions & { admissionTier?: GitAdmissionTier },
  run: () => Promise<T>
): Promise<T> {
  if (!router) {
    return run()
  }
  const admission = admitWslGit(options)
  const started = admission ? admission.then(run) : run()
  return started.catch((error: unknown) => {
    noteWslGitFailure(options, error)
    throw error
  })
}

export function resetWslGitAdmissionForTests(): void {
  missingUntil.clear()
  isDistroRunning = null
}
