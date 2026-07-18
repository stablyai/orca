const WSL_STATUS_ENVIRONMENT_MARKER = 'orca-wsl-status-environment-v1'

export type WslStatusEnvironment = {
  gitPath: string
  path: string
}

type WslStatusEnvironmentProbe = (distro: string) => Promise<WslStatusEnvironment | null>

const environmentsByDistro = new Map<string, WslStatusEnvironment | null>()
const unavailableUntilByDistro = new Map<string, number>()
const environmentProbesByDistro = new Map<string, Promise<WslStatusEnvironment | null>>()

// Why: a broken login rc must not add a failed probe before every fallback,
// but a transient distro startup failure should recover without restarting Orca.
const WSL_STATUS_ENVIRONMENT_RETRY_MS = 5 * 60 * 1000

function createAbortError(): Error {
  const error = new Error('The operation was aborted.')
  error.name = 'AbortError'
  return error
}

function waitForProbe(
  probe: Promise<WslStatusEnvironment | null>,
  signal?: AbortSignal
): Promise<WslStatusEnvironment | null> {
  if (!signal) {
    return probe
  }
  if (signal.aborted) {
    return Promise.reject(createAbortError())
  }
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort)
      reject(createAbortError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
    probe.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

export function buildWslStatusEnvironmentProbeCommand(): string {
  return [
    '_orca_git_path=$(command -v git) || exit 127',
    'case "$_orca_git_path" in /*) ;; *) exit 127 ;; esac',
    '[ -x "$_orca_git_path" ] || exit 127',
    `printf '\\000${WSL_STATUS_ENVIRONMENT_MARKER}\\000%s\\000%s\\000' "$_orca_git_path" "$PATH"`
  ].join('\n')
}

export function parseWslStatusEnvironmentProbe(stdout: string): WslStatusEnvironment | null {
  const marker = `\0${WSL_STATUS_ENVIRONMENT_MARKER}\0`
  const markerIndex = stdout.lastIndexOf(marker)
  if (markerIndex < 0) {
    return null
  }
  const fields = stdout.slice(markerIndex + marker.length).split('\0')
  const [gitPath, path] = fields
  if (!gitPath?.startsWith('/') || gitPath.includes('\n') || !path) {
    return null
  }
  return { gitPath, path }
}

export async function resolveWslStatusEnvironment(
  distro: string,
  probe: WslStatusEnvironmentProbe,
  signal?: AbortSignal
): Promise<WslStatusEnvironment | null> {
  if (environmentsByDistro.has(distro)) {
    const cached = environmentsByDistro.get(distro) ?? null
    const unavailableUntil = unavailableUntilByDistro.get(distro) ?? 0
    if (cached || unavailableUntil > Date.now()) {
      return cached
    }
    environmentsByDistro.delete(distro)
    unavailableUntilByDistro.delete(distro)
  }
  const activeProbe = environmentProbesByDistro.get(distro)
  if (activeProbe) {
    return waitForProbe(activeProbe, signal)
  }

  // Why: source-control reads from multiple worktrees can start together;
  // source the distro's login files only once for the whole burst.
  const nextProbe = probe(distro)
    .catch(() => null)
    .then((environment) => {
      environmentsByDistro.set(distro, environment)
      if (environment) {
        unavailableUntilByDistro.delete(distro)
      } else {
        unavailableUntilByDistro.set(distro, Date.now() + WSL_STATUS_ENVIRONMENT_RETRY_MS)
      }
      return environment
    })
    .finally(() => {
      if (environmentProbesByDistro.get(distro) === nextProbe) {
        environmentProbesByDistro.delete(distro)
      }
    })
  environmentProbesByDistro.set(distro, nextProbe)
  return waitForProbe(nextProbe, signal)
}

export function invalidateWslStatusEnvironment(
  distro: string,
  expected: WslStatusEnvironment
): void {
  if (environmentsByDistro.get(distro) === expected) {
    environmentsByDistro.delete(distro)
  }
}

export function clearWslStatusEnvironmentCacheForTests(): void {
  environmentsByDistro.clear()
  unavailableUntilByDistro.clear()
  environmentProbesByDistro.clear()
}
