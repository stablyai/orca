import { runProcess } from '../../shared/child-process/run-process'
import {
  buildWslCapturedLoginShellCommand,
  buildWslExecArgs
} from '../../shared/wsl-login-shell-command'
import { resolveWslExecutablePath } from './wsl-executable-path'

/**
 * A distro's login-shell environment, probed once and cached.
 *
 * Probes need the user's real PATH, but paying a login shell per call is what
 * stalls behind a blocking `~/.profile` (#14288) and lags WSL git (#9768).
 * Generalised from `git/wsl-git-read-environment.ts`, which already got this right.
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
 * A stopped distro recovers; one that cannot produce a POSIX PATH will not.
 *
 * Why 5s and not 30: four call sites surface "Try again" on a probe failure,
 * and for the whole window that retry could not spawn wsl.exe at all -- the
 * advice was guaranteed to fail. Long enough to stop a stampede, short enough
 * that the user's next click reaches a distro that has since warmed up.
 */
const TRANSIENT_RETRY_MS = 5_000
/**
 * Even a "permanent" verdict expires eventually.
 *
 * Exit 127 means no usable `env` -- but that is also what an `apt` upgrade
 * window looks like for a few seconds. With no expiry, one such moment disabled
 * every WSL feature on the distro until the app restarted, recoverable only if
 * the user happened to open Agents settings and press Refresh.
 */
const REJECTED_RETRY_MS = 10 * 60_000

type ProbeOutcome =
  | { kind: 'resolved'; environment: WslGuestEnvironment }
  | { kind: 'rejected' }
  | { kind: 'transient' }

const inFlight = new Map<string, Promise<WslGuestEnvironment | null>>()
const resolved = new Map<string, WslGuestEnvironment>()
const retryAfter = new Map<string, number>()
// The budget the cached probe actually had. A caller with materially more time
// deserves its own attempt rather than inheriting a verdict from a probe that
// was starved -- an optional 5s read must not hard-fail the 10s scan behind it.
const probedWithBudget = new Map<string, number>()

/** A payload that is not three absolute, single-line POSIX values is a failed probe. */
function parseProbePayload(payload: string | null): WslGuestEnvironment | null {
  if (payload === null) {
    return null
  }
  const [path = '', home = '', envBinary = ''] = payload.split('\0')
  const isCleanAbsolute = (value: string): boolean =>
    value.startsWith('/') && !value.includes('\n') && !value.includes('\r')
  if (!path.includes('/') || path.length > 32_768 || /[\n\r]/.test(path)) {
    return null
  }
  if (!isCleanAbsolute(home) || !isCleanAbsolute(envBinary)) {
    return null
  }
  return { path, home, envBinary }
}

async function probeGuestEnvironment(
  distro: string | undefined,
  budgetMs: number
): Promise<ProbeOutcome> {
  // Resolve `env` rather than assume /usr/bin/env: a distro that moved it would
  // otherwise fail every later call.
  const script = [
    '_orca_env=$(command -v env 2>/dev/null || true)',
    'case "$_orca_env" in /*) [ -x "$_orca_env" ] || exit 127 ;; *) exit 127 ;; esac',
    `printf '%s\\0%s\\0%s' "$PATH" "$HOME" "$_orca_env"`
  ].join('\n')
  const captured = buildWslCapturedLoginShellCommand(script)
  const result = await runProcess({
    program: resolveWslExecutablePath(),
    args: buildWslExecArgs(distro, ['sh', '-c', captured.command]),
    timeoutMs: Math.min(PROBE_TIMEOUT_MS, budgetMs),
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
  // Why transient and not rejected: an unparseable payload is usually a fence
  // lost to a chatty rc truncated at PROBE_MAX_OUTPUT_BYTES, which recovers.
  // Caching that permanently would disable every WSL feature on this distro
  // for the process lifetime. Only exit 127 ("no usable env") is permanent.
  return environment ? { kind: 'resolved', environment } : { kind: 'transient' }
}

function cacheKey(distro: string | undefined): string {
  return distro ?? ''
}

/** Null means "could not ask", never "has no PATH" -- callers fall back. */
export function getWslGuestEnvironment(
  distro: string | undefined,
  /**
   * The caller's remaining budget. Without it the probe ran on its own 10s
   * timer, so a 5s caller could reach `runProcess` with 1ms left and report a
   * timeout for a command that would have taken milliseconds.
   */
  budgetMs = PROBE_TIMEOUT_MS
): Promise<WslGuestEnvironment | null> {
  const key = cacheKey(distro)
  const retry = retryAfter.get(key)
  if (retry !== undefined && Date.now() >= retry) {
    inFlight.delete(key)
    retryAfter.delete(key)
    probedWithBudget.delete(key)
  }
  // A failed verdict from a starved probe should not bind a caller who brought
  // more time. 1.5x is the threshold: enough to matter, not so low that every
  // caller re-probes.
  const failedBudget = probedWithBudget.get(key)
  if (failedBudget !== undefined && budgetMs > failedBudget * 1.5) {
    inFlight.delete(key)
    retryAfter.delete(key)
    probedWithBudget.delete(key)
  }

  // Why an explicit gate: dropping the in-flight entry on a transient failure
  // means nothing else stops a re-probe inside the window, so the burst this
  // cache exists to collapse would come straight back.
  const cooldown = retryAfter.get(key)
  if (cooldown !== undefined && Date.now() < cooldown && !inFlight.has(key)) {
    return Promise.resolve(resolved.get(key) ?? null)
  }

  const existing = inFlight.get(key)
  if (existing) {
    // Why race: joining an in-flight probe used to mean waiting out the
    // *starter's* budget, so a joiner could reach its own command with 1ms --
    // the exact hazard the budget plumbing was added to remove.
    return Promise.race([
      existing,
      new Promise<null>((resolve) => {
        const timer = setTimeout(() => resolve(null), budgetMs)
        timer.unref?.()
      })
    ])
  }
  // Store before awaiting so a burst collapses into one probe.
  // Why catch: runProcess REJECTS when the child cannot be started (ENOENT on a
  // host without System32\wsl.exe, EAGAIN under memory pressure). Uncaught, the
  // rejected promise stays in `inFlight` and every later call re-throws it for
  // the process lifetime -- all WSL features wedged until restart.
  const probe = probeGuestEnvironment(distro, budgetMs)
    .catch((): ProbeOutcome => ({ kind: 'transient' }))
    .then((outcome) => {
      if (inFlight.get(key) !== probe) {
        return outcome.kind === 'resolved' ? outcome.environment : null
      }
      if (outcome.kind === 'resolved') {
        resolved.set(key, outcome.environment)
        retryAfter.delete(key)
        probedWithBudget.delete(key)
        return outcome.environment
      }
      retryAfter.set(
        key,
        Date.now() + (outcome.kind === 'transient' ? TRANSIENT_RETRY_MS : REJECTED_RETRY_MS)
      )
      probedWithBudget.set(key, budgetMs)
      // Why drop the entry: keeping a null-resolving promise in `inFlight` made
      // `retryAfter` the only way back, and the probe cap left the 1.5x budget
      // escape unreachable. Deleting it lets the window alone gate the re-probe.
      if (outcome.kind === 'transient' && inFlight.get(key) === probe) {
        inFlight.delete(key)
      }
      return null
    })
  inFlight.set(key, probe)
  return probe
}

/** Needed so a tool installed inside a running distro appears without a restart. */
export function invalidateWslGuestEnvironment(distro?: string, all = false): void {
  // Why an explicit flag: everywhere else in this module `undefined` means the
  // default distro, so overloading it to mean "all" made a default-distro
  // Refresh evict every distro and pay a login shell for each.
  if (all) {
    inFlight.clear()
    resolved.clear()
    retryAfter.clear()
    probedWithBudget.clear()
    return
  }
  const key = cacheKey(distro)
  inFlight.delete(key)
  resolved.delete(key)
  retryAfter.delete(key)
  probedWithBudget.delete(key)
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
