import { execFile } from 'node:child_process'
import {
  buildWslCapturedLoginShellCommand,
  buildWslExecArgs
} from '../../shared/wsl-login-shell-command'

export type WslGitReadEnvironment = { gitPath: string; home: string; path: string }

const PROBE_TIMEOUT_MS = 10_000
const SHELL_FREE_PROBE_TIMEOUT_MS = 5_000
/**
 * How long a read may wait for a cold probe before taking the login shell.
 * Short enough that a wedged distro cannot stall the panel, long enough that a
 * healthy one resolves and every later read runs shell-free.
 */
export const WSL_GIT_READ_ENVIRONMENT_WAIT_MS = 1_500
const PROBE_MAX_BUFFER = 64 * 1024
const TRANSIENT_PROBE_RETRY_MS = 30_000
/**
 * How long reads stay on the shell-free fallback before the login probe runs again.
 * Why longer than the transient retry: each retry starts the user's slow login shell
 * and kills it at the probe timeout, and killing rc files mid-run is itself one way
 * a shell becomes slow (pyenv's rehash leaves its lock file behind when killed).
 */
const SHELL_FREE_FALLBACK_RETRY_MS = 5 * 60_000
const MAX_WSL_GIT_READ_ENVIRONMENT_DISTROS = 128
const environmentByDistro = new Map<string, Promise<WslGitReadEnvironment | null>>()
// Why the null entries matter: a settled "no direct route" answer is what lets a read skip the
// bounded probe wait entirely instead of racing an already-decided promise on every call.
const settledEnvironmentByDistro = new Map<string, WslGitReadEnvironment | null>()
const transientRetryAfterByDistro = new Map<string, number>()
// Distros whose settled environment came from the shell-free probe, not the login shell.
const shellFreeFallbackDistros = new Set<string>()

function forgetDistroState(distro: string): void {
  environmentByDistro.delete(distro)
  settledEnvironmentByDistro.delete(distro)
  transientRetryAfterByDistro.delete(distro)
  shellFreeFallbackDistros.delete(distro)
}

function touchDistroState(distro: string): void {
  const settled = settledEnvironmentByDistro.get(distro)
  if (settledEnvironmentByDistro.has(distro)) {
    settledEnvironmentByDistro.delete(distro)
    settledEnvironmentByDistro.set(distro, settled ?? null)
  }
  while (settledEnvironmentByDistro.size > MAX_WSL_GIT_READ_ENVIRONMENT_DISTROS) {
    const oldest = settledEnvironmentByDistro.keys().next().value
    if (oldest === undefined) {
      break
    }
    forgetDistroState(oldest)
  }
  while (environmentByDistro.size > MAX_WSL_GIT_READ_ENVIRONMENT_DISTROS) {
    const oldest = environmentByDistro.keys().next().value
    if (oldest === undefined) {
      break
    }
    forgetDistroState(oldest)
  }
}

type ProbeOutcome =
  | { kind: 'resolved'; environment: WslGitReadEnvironment }
  | { kind: 'shell-free'; environment: WslGitReadEnvironment }
  | { kind: 'rejected' }
  | { kind: 'transient' }

function parseProbe(payload: string | null): WslGitReadEnvironment | null {
  if (payload === null) {
    return null
  }
  const fields = payload.split('\0')
  const path = fields[0] ?? ''
  const gitPath = fields[1] ?? ''
  const home = fields[2] ?? ''
  if (
    !path.includes('/') ||
    path.length > 32_768 ||
    !gitPath.startsWith('/') ||
    gitPath.includes('\n') ||
    gitPath.includes('\r') ||
    !home.startsWith('/') ||
    home.includes('\n') ||
    home.includes('\r')
  ) {
    return null
  }
  return { gitPath, home, path }
}

const PROBE_COMMAND = [
  '_orca_git_path=$(command -v git 2>/dev/null || true)',
  'case "$_orca_git_path" in /*) [ -x "$_orca_git_path" ] || exit 127 ;; *) exit 127 ;; esac',
  'if [ -n "${XDG_CONFIG_HOME:-}" ] || [ -n "${LD_LIBRARY_PATH:-}" ] || env | grep -q \'^GIT_\'; then exit 78; fi',
  `printf '%s\\0%s\\0%s' "$PATH" "$_orca_git_path" "$HOME"`
].join('\n')

function runProbe(
  distro: string,
  shellArgs: readonly string[],
  timeout: number,
  readPayload: (stdout: string) => string | null
): Promise<ProbeOutcome> {
  return new Promise((resolve) => {
    execFile(
      'wsl.exe',
      buildWslExecArgs(distro, shellArgs),
      {
        encoding: 'utf8',
        maxBuffer: PROBE_MAX_BUFFER,
        timeout,
        windowsHide: true
      },
      (error, stdout) => {
        if (error) {
          const code = (error as { code?: unknown }).code
          resolve(code === 78 || code === 127 ? { kind: 'rejected' } : { kind: 'transient' })
          return
        }
        const environment = parseProbe(readPayload(String(stdout)))
        resolve(environment ? { kind: 'resolved', environment } : { kind: 'rejected' })
      }
    )
  })
}

function probeLoginShellEnvironment(distro: string): Promise<ProbeOutcome> {
  const captured = buildWslCapturedLoginShellCommand(PROBE_COMMAND)
  return runProbe(distro, ['sh', '-lc', captured.command], PROBE_TIMEOUT_MS, captured.readStdout)
}

/**
 * Locate Git without running any rc file.
 *
 * Why: when the login shell cannot answer the probe in time (a `~/.profile` that
 * blocks, e.g. on a stale pyenv rehash lock), the only other route for a read is
 * that same login shell, so every read times out and the whole repo looks broken.
 * Reads need nothing the login shell provides, so a Git on the distro's default
 * PATH serves them while the login probe is retried in the background. Commands
 * that are not reads (hooks, credentials, network) stay on the login shell.
 */
function probeShellFreeEnvironment(distro: string): Promise<ProbeOutcome> {
  return runProbe(
    distro,
    ['sh', '-c', PROBE_COMMAND],
    SHELL_FREE_PROBE_TIMEOUT_MS,
    (stdout) => stdout
  )
}

async function probeWslGitReadEnvironment(distro: string): Promise<ProbeOutcome> {
  const outcome = await probeLoginShellEnvironment(distro)
  if (outcome.kind !== 'transient') {
    return outcome
  }
  const fallback = await probeShellFreeEnvironment(distro)
  return fallback.kind === 'resolved'
    ? { kind: 'shell-free', environment: fallback.environment }
    : outcome
}

export function getWslGitReadEnvironment(distro: string): Promise<WslGitReadEnvironment | null> {
  const retryAfter = transientRetryAfterByDistro.get(distro)
  if (retryAfter !== undefined && Date.now() >= retryAfter) {
    environmentByDistro.delete(distro)
    transientRetryAfterByDistro.delete(distro)
    // Why a shell-free fallback stays settled: reads keep using it while the login
    // probe retries, instead of dropping back to the slow login shell meanwhile.
    if (!shellFreeFallbackDistros.has(distro)) {
      settledEnvironmentByDistro.delete(distro)
    }
  }
  let environment = environmentByDistro.get(distro)
  if (!environment) {
    environment = probeWslGitReadEnvironment(distro).then((outcome) => {
      const settledEnvironment =
        outcome.kind === 'resolved' || outcome.kind === 'shell-free' ? outcome.environment : null
      if (environmentByDistro.get(distro) !== environment) {
        return settledEnvironment
      }
      settledEnvironmentByDistro.set(distro, settledEnvironment)
      touchDistroState(distro)
      if (outcome.kind === 'shell-free') {
        shellFreeFallbackDistros.add(distro)
      } else {
        shellFreeFallbackDistros.delete(distro)
      }
      if (outcome.kind === 'transient') {
        transientRetryAfterByDistro.set(distro, Date.now() + TRANSIENT_PROBE_RETRY_MS)
      } else if (outcome.kind === 'shell-free') {
        transientRetryAfterByDistro.set(distro, Date.now() + SHELL_FREE_FALLBACK_RETRY_MS)
      } else {
        transientRetryAfterByDistro.delete(distro)
      }
      return settledEnvironment
    })
    environmentByDistro.set(distro, environment)
    touchDistroState(distro)
  }
  touchDistroState(distro)
  return environment
}

/**
 * Re-run the login probe for a distro whose reads run on the shell-free fallback, once due.
 *
 * Why a separate entry point: a read that finds a settled environment never calls
 * `getWslGitReadEnvironment`, so without this the fallback would never be upgraded
 * to the login environment after a one-off slow start (a cold distro boot).
 */
export function retryWslGitLoginProbeIfDue(distro: string): void {
  if (!shellFreeFallbackDistros.has(distro)) {
    return
  }
  const retryAfter = transientRetryAfterByDistro.get(distro)
  if (retryAfter !== undefined && Date.now() >= retryAfter) {
    void getWslGitReadEnvironment(distro)
  }
}

/**
 * What the shared probe settled to: the environment, `null` for a distro with no
 * usable direct route, `undefined` while nothing has been decided yet.
 */
export function peekWslGitReadEnvironment(
  distro: string
): WslGitReadEnvironment | null | undefined {
  return settledEnvironmentByDistro.get(distro)
}

/** True once the probe has decided either way, so a read has nothing left to wait for. */
export function isWslGitReadEnvironmentSettled(distro: string): boolean {
  return settledEnvironmentByDistro.has(distro)
}

export function invalidateWslGitReadEnvironment(distro: string): void {
  forgetDistroState(distro)
}

export function disableWslGitReadEnvironment(distro: string): void {
  environmentByDistro.set(distro, Promise.resolve(null))
  settledEnvironmentByDistro.set(distro, null)
  touchDistroState(distro)
  transientRetryAfterByDistro.delete(distro)
  shellFreeFallbackDistros.delete(distro)
}

export function resetWslGitReadEnvironmentForTests(): void {
  environmentByDistro.clear()
  settledEnvironmentByDistro.clear()
  transientRetryAfterByDistro.clear()
  shellFreeFallbackDistros.clear()
}

export function seedWslGitReadEnvironmentForTests(
  distro: string,
  environment: WslGitReadEnvironment
): void {
  environmentByDistro.set(distro, Promise.resolve(environment))
  settledEnvironmentByDistro.set(distro, environment)
  touchDistroState(distro)
  transientRetryAfterByDistro.delete(distro)
  shellFreeFallbackDistros.delete(distro)
}
