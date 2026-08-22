import { runProcess } from '../../shared/child-process/run-process'
import {
  buildWslCapturedLoginShellCommand,
  buildWslExecArgs
} from '../../shared/wsl-login-shell-command'
import { resolveWslExecutablePath } from './wsl-executable-path'

/**
 * The login-shell environment of a distro, probed once and cached.
 *
 * Why this exists: a probe needs the user's real PATH (nvm, mise and asdf all
 * install into rc files), but paying for a login shell on every probe is what
 * made `cli:getWslInstallStatus` time out behind a blocking `~/.profile`
 * (#14288) and what makes WSL git operations lag (#9768). Probe the login shell
 * exactly once per distro, then run everything else with no shell at all.
 *
 * Generalised from `src/main/git/wsl-git-read-environment.ts`, which is the one
 * WSL caller that already got this right.
 */

export type WslGuestEnvironment = {
  /** Login-shell PATH, as the user's own terminal would see it. */
  path: string
  home: string
  /** Absolute path to `env`, used to run programs without a shell. */
  envBinary: string
}

const PROBE_TIMEOUT_MS = 10_000
const PROBE_MAX_OUTPUT_BYTES = 64 * 1024
/**
 * Why retry a timeout but not a malformed answer: a stopped distro or a
 * momentarily wedged `wsl.exe` recovers on its own, while a distro that cannot
 * produce a POSIX PATH will not start doing so. Retrying the second forever is
 * how a probe becomes a poller.
 */
const TRANSIENT_RETRY_MS = 30_000

type ProbeOutcome =
  | { kind: 'resolved'; environment: WslGuestEnvironment }
  | { kind: 'rejected' }
  | { kind: 'transient' }

const inFlight = new Map<string, Promise<WslGuestEnvironment | null>>()
const resolved = new Map<string, WslGuestEnvironment>()
const retryAfter = new Map<string, number>()

/** A payload that is not three absolute, single-line POSIX values is a failed probe. */
function parseProbePayload(payload: string | null): WslGuestEnvironment | null {
  if (payload === null) {
    return null
  }
  const [path = '', home = '', envBinary = ''] = payload.split('\0')
  const isCleanAbsolute = (value: string): boolean =>
    value.startsWith('/') && !value.includes('\n') && !value.includes('\r')
  if (!path.includes('/') || path.length > 32_768 || path.includes('\n')) {
    return null
  }
  if (!isCleanAbsolute(home) || !isCleanAbsolute(envBinary)) {
    return null
  }
  return { path, home, envBinary }
}

async function probeGuestEnvironment(distro: string | undefined): Promise<ProbeOutcome> {
  // Why resolve `env` rather than assume /usr/bin/env: it is /usr/bin/env on
  // Debian, Ubuntu, Fedora and Arch, but the probe costs nothing extra here and
  // a distro that puts it elsewhere would otherwise fail every later call.
  const script = [
    '_orca_env=$(command -v env 2>/dev/null || true)',
    'case "$_orca_env" in /*) [ -x "$_orca_env" ] || exit 127 ;; *) exit 127 ;; esac',
    `printf '%s\\0%s\\0%s' "$PATH" "$HOME" "$_orca_env"`
  ].join('\n')
  const captured = buildWslCapturedLoginShellCommand(script)
  const result = await runProcess({
    program: resolveWslExecutablePath(),
    args: buildWslExecArgs(distro, ['sh', '-c', captured.command]),
    timeoutMs: PROBE_TIMEOUT_MS,
    maxOutputBytes: PROBE_MAX_OUTPUT_BYTES
  })
  if (result.timedOut) {
    return { kind: 'transient' }
  }
  if (result.code !== 0) {
    // 127 is our own "no usable env"; anything else is the distro being
    // unavailable, which is worth retrying.
    return result.code === 127 ? { kind: 'rejected' } : { kind: 'transient' }
  }
  const environment = parseProbePayload(captured.readStdout(result.stdout))
  return environment ? { kind: 'resolved', environment } : { kind: 'rejected' }
}

function cacheKey(distro: string | undefined): string {
  return distro ?? ''
}

/**
 * The distro's login-shell environment, or null when it cannot be established.
 *
 * Null is "we could not ask", never "the distro has no PATH" — callers fall
 * back to the interactive lane rather than running with an empty environment.
 */
export function getWslGuestEnvironment(
  distro: string | undefined
): Promise<WslGuestEnvironment | null> {
  const key = cacheKey(distro)
  const retry = retryAfter.get(key)
  if (retry !== undefined && Date.now() >= retry) {
    inFlight.delete(key)
    retryAfter.delete(key)
  }
  const existing = inFlight.get(key)
  if (existing) {
    return existing
  }
  // Why store the promise before awaiting: a 32-wide burst during teardown must
  // collapse into one probe, not 32 login shells.
  const probe = probeGuestEnvironment(distro).then((outcome) => {
    if (inFlight.get(key) !== probe) {
      return outcome.kind === 'resolved' ? outcome.environment : null
    }
    if (outcome.kind === 'resolved') {
      resolved.set(key, outcome.environment)
      retryAfter.delete(key)
      return outcome.environment
    }
    if (outcome.kind === 'transient') {
      retryAfter.set(key, Date.now() + TRANSIENT_RETRY_MS)
    }
    return null
  })
  inFlight.set(key, probe)
  return probe
}

/**
 * Drop a distro's cached environment.
 *
 * Why callers need this: a user who installs nvm inside a running distro would
 * otherwise keep the pre-install PATH until Orca restarts, and read that as the
 * same detection bug this cache exists to fix.
 */
export function invalidateWslGuestEnvironment(distro?: string): void {
  if (distro === undefined) {
    inFlight.clear()
    resolved.clear()
    retryAfter.clear()
    return
  }
  const key = cacheKey(distro)
  inFlight.delete(key)
  resolved.delete(key)
  retryAfter.delete(key)
}

/** Test-only: the cached value without probing. */
export function peekWslGuestEnvironment(
  distro: string | undefined
): WslGuestEnvironment | undefined {
  return resolved.get(cacheKey(distro))
}

/** Test-only: pretend a distro has already been probed. */
export function seedWslGuestEnvironmentForTests(
  distro: string | undefined,
  environment: WslGuestEnvironment
): void {
  const key = cacheKey(distro)
  inFlight.set(key, Promise.resolve(environment))
  resolved.set(key, environment)
  retryAfter.delete(key)
}
