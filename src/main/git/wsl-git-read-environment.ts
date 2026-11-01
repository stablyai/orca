import { execFile } from 'node:child_process'
import { assertWslDistroAllowed } from '@orca/process-host/wsl-distro-allowlist'
import {
  buildWslCapturedLoginShellCommand,
  buildWslExecArgs
} from '../../shared/wsl-login-shell-command'
import { resolveWslInteropSpawnCwd } from '../wsl-interop-spawn-directory'

export type WslGitReadEnvironment = { gitPath: string; home: string; path: string }

const PROBE_TIMEOUT_MS = 10_000
/** Bound cold-probe waits; reads fall back to the login shell while a wedged distro remains unresolved. */
export const WSL_GIT_READ_ENVIRONMENT_WAIT_MS = 1_500
const PROBE_MAX_BUFFER = 64 * 1024
const TRANSIENT_PROBE_RETRY_MS = 30_000
const MAX_WSL_GIT_READ_ENVIRONMENT_DISTROS = 128
const environmentByDistro = new Map<string, Promise<WslGitReadEnvironment | null>>()
// Cache settled nulls so later reads skip the probe wait.
const settledEnvironmentByDistro = new Map<string, WslGitReadEnvironment | null>()
const transientRetryAfterByDistro = new Map<string, number>()

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
    settledEnvironmentByDistro.delete(oldest)
    environmentByDistro.delete(oldest)
    transientRetryAfterByDistro.delete(oldest)
  }
  while (environmentByDistro.size > MAX_WSL_GIT_READ_ENVIRONMENT_DISTROS) {
    const oldest = environmentByDistro.keys().next().value
    if (oldest === undefined) {
      break
    }
    environmentByDistro.delete(oldest)
    settledEnvironmentByDistro.delete(oldest)
    transientRetryAfterByDistro.delete(oldest)
  }
}

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
  const args = buildWslExecArgs(distro, ['sh', '-lc', captured.command])
  return new Promise((resolve) => {
    try {
      assertWslDistroAllowed('wsl.exe', args)
    } catch {
      resolve({ kind: 'rejected' })
      return
    }
    execFile(
      'wsl.exe',
      args,
      {
        encoding: 'utf8',
        maxBuffer: PROBE_MAX_BUFFER,
        timeout: PROBE_TIMEOUT_MS,
        windowsHide: true,
        cwd: resolveWslInteropSpawnCwd()
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
        touchDistroState(distro)
        transientRetryAfterByDistro.delete(distro)
        return outcome.environment
      }
      settledEnvironmentByDistro.set(distro, null)
      touchDistroState(distro)
      if (outcome.kind === 'transient') {
        transientRetryAfterByDistro.set(distro, Date.now() + TRANSIENT_PROBE_RETRY_MS)
      }
      return null
    })
    environmentByDistro.set(distro, environment)
    touchDistroState(distro)
  }
  touchDistroState(distro)
  return environment
}

/** null means no direct route; undefined means the probe has not settled. */
export function peekWslGitReadEnvironment(
  distro: string
): WslGitReadEnvironment | null | undefined {
  return settledEnvironmentByDistro.get(distro)
}

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
  touchDistroState(distro)
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
  touchDistroState(distro)
  transientRetryAfterByDistro.delete(distro)
}
