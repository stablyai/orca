import { execFile } from 'node:child_process'
import {
  buildWslCapturedLoginShellCommand,
  buildWslExecArgs
} from '../../shared/wsl-login-shell-command'

export type WslGitReadEnvironment = { gitPath: string; home: string; path: string }

const PROBE_TIMEOUT_MS = 10_000
/**
 * How long a read may wait for a cold probe before taking the login shell.
 * Short enough that a wedged distro cannot stall the panel, long enough that a
 * healthy one resolves and every later read runs shell-free.
 */
export const WSL_GIT_READ_ENVIRONMENT_WAIT_MS = 1_500
const PROBE_MAX_BUFFER = 64 * 1024
const TRANSIENT_PROBE_RETRY_MS = 30_000
const environmentByDistro = new Map<string, Promise<WslGitReadEnvironment | null>>()
// Why the null entries matter: a settled "no direct route" answer is what lets a read skip the
// bounded probe wait entirely instead of racing an already-decided promise on every call.
const settledEnvironmentByDistro = new Map<string, WslGitReadEnvironment | null>()
const transientRetryAfterByDistro = new Map<string, number>()

type ProbeOutcome =
  | { kind: 'resolved'; environment: WslGitReadEnvironment }
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

function probeWslGitReadEnvironment(distro: string): Promise<ProbeOutcome> {
  const probeCommand = [
    '_orca_git_path=$(command -v git 2>/dev/null || true)',
    'case "$_orca_git_path" in /*) [ -x "$_orca_git_path" ] || exit 127 ;; *) exit 127 ;; esac',
    'if [ -n "${XDG_CONFIG_HOME:-}" ] || [ -n "${LD_LIBRARY_PATH:-}" ] || env | grep -q \'^GIT_\'; then exit 78; fi',
    `printf '%s\\0%s\\0%s' "$PATH" "$_orca_git_path" "$HOME"`
  ].join('\n')
  const captured = buildWslCapturedLoginShellCommand(probeCommand)
  return new Promise((resolve) => {
    execFile(
      'wsl.exe',
      buildWslExecArgs(distro, ['sh', '-lc', captured.command]),
      {
        encoding: 'utf8',
        maxBuffer: PROBE_MAX_BUFFER,
        timeout: PROBE_TIMEOUT_MS,
        windowsHide: true
      },
      (error, stdout) => {
        if (error) {
          const code = (error as { code?: unknown }).code
          resolve(code === 78 || code === 127 ? { kind: 'rejected' } : { kind: 'transient' })
          return
        }
        const environment = parseProbe(captured.readStdout(String(stdout)))
        resolve(environment ? { kind: 'resolved', environment } : { kind: 'rejected' })
      }
    )
  })
}

export function getWslGitReadEnvironment(distro: string): Promise<WslGitReadEnvironment | null> {
  const retryAfter = transientRetryAfterByDistro.get(distro)
  if (retryAfter !== undefined && Date.now() >= retryAfter) {
    environmentByDistro.delete(distro)
    settledEnvironmentByDistro.delete(distro)
    transientRetryAfterByDistro.delete(distro)
  }
  let environment = environmentByDistro.get(distro)
  if (!environment) {
    environment = probeWslGitReadEnvironment(distro).then((outcome) => {
      if (environmentByDistro.get(distro) !== environment) {
        return outcome.kind === 'resolved' ? outcome.environment : null
      }
      if (outcome.kind === 'resolved') {
        settledEnvironmentByDistro.set(distro, outcome.environment)
        transientRetryAfterByDistro.delete(distro)
        return outcome.environment
      }
      settledEnvironmentByDistro.set(distro, null)
      if (outcome.kind === 'transient') {
        transientRetryAfterByDistro.set(distro, Date.now() + TRANSIENT_PROBE_RETRY_MS)
      }
      return null
    })
    environmentByDistro.set(distro, environment)
  }
  return environment
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
  environmentByDistro.delete(distro)
  settledEnvironmentByDistro.delete(distro)
  transientRetryAfterByDistro.delete(distro)
}

export function disableWslGitReadEnvironment(distro: string): void {
  environmentByDistro.set(distro, Promise.resolve(null))
  settledEnvironmentByDistro.set(distro, null)
  transientRetryAfterByDistro.delete(distro)
}

export function resetWslGitReadEnvironmentForTests(): void {
  environmentByDistro.clear()
  settledEnvironmentByDistro.clear()
  transientRetryAfterByDistro.clear()
}

export function seedWslGitReadEnvironmentForTests(
  distro: string,
  environment: WslGitReadEnvironment
): void {
  environmentByDistro.set(distro, Promise.resolve(environment))
  settledEnvironmentByDistro.set(distro, environment)
  transientRetryAfterByDistro.delete(distro)
}
