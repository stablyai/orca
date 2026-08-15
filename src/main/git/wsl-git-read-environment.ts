import { execFile } from 'node:child_process'
import {
  buildWslLoginShellCommand,
  escapeWslShCommandForWindows
} from '../../shared/wsl-login-shell-command'

export type WslGitReadEnvironment = { gitPath: string; home: string; path: string }

const PROBE_MARKER = 'ORCA_WSL_GIT_READ_ENV_V1'
const PROBE_TIMEOUT_MS = 10_000
const PROBE_MAX_BUFFER = 64 * 1024
const TRANSIENT_PROBE_RETRY_MS = 30_000
const environmentByDistro = new Map<string, Promise<WslGitReadEnvironment | null>>()
const resolvedEnvironmentByDistro = new Map<string, WslGitReadEnvironment>()
const transientRetryAfterByDistro = new Map<string, number>()

type ProbeOutcome =
  | { kind: 'resolved'; environment: WslGitReadEnvironment }
  | { kind: 'rejected' }
  | { kind: 'transient' }

function parseProbe(stdout: string): WslGitReadEnvironment | null {
  const fields = stdout.split('\0')
  const markerIndex = fields.lastIndexOf(PROBE_MARKER)
  const path = fields[markerIndex + 1] ?? ''
  const gitPath = fields[markerIndex + 2] ?? ''
  const home = fields[markerIndex + 3] ?? ''
  if (
    markerIndex === -1 ||
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
    `printf '\\0${PROBE_MARKER}\\0%s\\0%s\\0%s\\0' "$PATH" "$_orca_git_path" "$HOME"`
  ].join('\n')
  const script = escapeWslShCommandForWindows(buildWslLoginShellCommand(probeCommand))
  return new Promise((resolve) => {
    execFile(
      'wsl.exe',
      ['-d', distro, '--', 'sh', '-lc', script],
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
        const environment = parseProbe(String(stdout))
        resolve(environment ? { kind: 'resolved', environment } : { kind: 'rejected' })
      }
    )
  })
}

export function getWslGitReadEnvironment(distro: string): Promise<WslGitReadEnvironment | null> {
  const retryAfter = transientRetryAfterByDistro.get(distro)
  if (retryAfter !== undefined && Date.now() >= retryAfter) {
    environmentByDistro.delete(distro)
    transientRetryAfterByDistro.delete(distro)
  }
  let environment = environmentByDistro.get(distro)
  if (!environment) {
    environment = probeWslGitReadEnvironment(distro).then((outcome) => {
      if (environmentByDistro.get(distro) !== environment) {
        return outcome.kind === 'resolved' ? outcome.environment : null
      }
      if (outcome.kind === 'resolved') {
        resolvedEnvironmentByDistro.set(distro, outcome.environment)
        transientRetryAfterByDistro.delete(distro)
        return outcome.environment
      }
      if (outcome.kind === 'transient') {
        transientRetryAfterByDistro.set(distro, Date.now() + TRANSIENT_PROBE_RETRY_MS)
      }
      return null
    })
    environmentByDistro.set(distro, environment)
  }
  return environment
}

export function peekWslGitReadEnvironment(distro: string): WslGitReadEnvironment | undefined {
  return resolvedEnvironmentByDistro.get(distro)
}

export function invalidateWslGitReadEnvironment(distro: string): void {
  environmentByDistro.delete(distro)
  resolvedEnvironmentByDistro.delete(distro)
  transientRetryAfterByDistro.delete(distro)
}

export function disableWslGitReadEnvironment(distro: string): void {
  environmentByDistro.set(distro, Promise.resolve(null))
  resolvedEnvironmentByDistro.delete(distro)
  transientRetryAfterByDistro.delete(distro)
}

export function resetWslGitReadEnvironmentForTests(): void {
  environmentByDistro.clear()
  resolvedEnvironmentByDistro.clear()
  transientRetryAfterByDistro.clear()
}

export function seedWslGitReadEnvironmentForTests(
  distro: string,
  environment: WslGitReadEnvironment
): void {
  environmentByDistro.set(distro, Promise.resolve(environment))
  resolvedEnvironmentByDistro.set(distro, environment)
  transientRetryAfterByDistro.delete(distro)
}
