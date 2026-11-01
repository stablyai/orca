import { runProcess } from '@orca/process-host'
import {
  buildWslCapturedLoginShellCommand,
  buildWslExecArgs
} from '../../shared/wsl-login-shell-command'
import { resolveWslExecutablePath } from './wsl-executable-path'
import { resolveWslInteropSpawnCwd } from '../wsl-interop-spawn-directory'

/** Cache the distro login environment to retain user PATH without repeated blocking profile/login-shell probes (#14288/#9768). */

export type WslGuestEnvironment = {
  /** Login-shell PATH, as the user's own terminal would see it. */
  path: string
  home: string
  /** Absolute path to `env`, used to run programs without a shell. */
  envBinary: string
}

const PROBE_TIMEOUT_MS = 10_000
const PROBE_MAX_OUTPUT_BYTES = 64 * 1024
/** Keep transient cooldown short enough for a useful Try Again, but long enough to collapse cold-distro probe bursts. */
const TRANSIENT_RETRY_MS = 5_000
/** Explicit no-usable-env verdicts also expire: upgrades can temporarily remove env and must not disable WSL until restart. */
const REJECTED_RETRY_MS = 10 * 60_000

type ProbeOutcome =
  | { kind: 'resolved'; environment: WslGuestEnvironment }
  | { kind: 'rejected' }
  | { kind: 'transient' }

const inFlight = new Map<string, Promise<WslGuestEnvironment | null>>()
const resolved = new Map<string, WslGuestEnvironment>()
const retryAfter = new Map<string, number>()
// A later caller with materially more budget deserves a retry after a starved probe.
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
  // Resolve env instead of assuming /usr/bin/env so relocated installs remain usable.
  const script = [
    '_orca_env=$(command -v env 2>/dev/null || true)',
    'case "$_orca_env" in /*) [ -x "$_orca_env" ] || exit 127 ;; *) exit 127 ;; esac',
    `printf '%s\\0%s\\0%s' "$PATH" "$HOME" "$_orca_env"`
  ].join('\n')
  const captured = buildWslCapturedLoginShellCommand(script)
  const result = await runProcess({
    program: resolveWslExecutablePath(),
    args: buildWslExecArgs(distro, ['sh', '-c', captured.command]),
    // This path spawns wsl.exe directly; request UTF-8 or its UTF-16 errors corrupt the NUL-delimited payload (#9010).
    env: { ...process.env, WSL_UTF8: '1' },
    cwd: resolveWslInteropSpawnCwd(),
    timeoutMs: Math.min(PROBE_TIMEOUT_MS, budgetMs),
    maxOutputBytes: PROBE_MAX_OUTPUT_BYTES
  })
  if (result.timedOut) {
    return { kind: 'transient' }
  }
  if (result.code !== 0) {
    // Only explicit no-usable-env exit 127 gets the longer rejected cooldown; other failures are transient.
    return result.code === 127 ? { kind: 'rejected' } : { kind: 'transient' }
  }
  const environment = parseProbePayload(captured.readStdout(result.stdout))
  // Malformed output often means truncated/chatty rc lost the fence; retry transiently instead of applying the longer exit-127 cooldown.
  return environment ? { kind: 'resolved', environment } : { kind: 'transient' }
}

function cacheKey(distro: string | undefined): string {
  return distro ?? ''
}

/** Null means "could not ask", never "has no PATH" -- callers fall back. */
export function getWslGuestEnvironment(
  distro: string | undefined,
  /** Respect the caller's remaining budget or probing may consume all time reserved for its actual command. */
  budgetMs = PROBE_TIMEOUT_MS
): Promise<WslGuestEnvironment | null> {
  const key = cacheKey(distro)
  const cached = resolved.get(key)
  if (cached) {
    return Promise.resolve(cached)
  }
  const retry = retryAfter.get(key)
  if (retry !== undefined && Date.now() >= retry) {
    inFlight.delete(key)
    retryAfter.delete(key)
    probedWithBudget.delete(key)
  }
  // Retry failed probes with >1.5x budget: meaningful headroom without reprobes for every caller.
  const failedBudget = probedWithBudget.get(key)
  if (failedBudget !== undefined && budgetMs > failedBudget * 1.5) {
    inFlight.delete(key)
    retryAfter.delete(key)
    probedWithBudget.delete(key)
  }

  // Dropping in-flight failures must not bypass cooldown and recreate the spawn burst.
  const cooldown = retryAfter.get(key)
  if (cooldown !== undefined && Date.now() < cooldown && !inFlight.has(key)) {
    return Promise.resolve(resolved.get(key) ?? null)
  }

  const existing = inFlight.get(key)
  if (existing) {
    // Join only within this caller's budget, not the starter's deadline.
    let timer: ReturnType<typeof setTimeout>
    return Promise.race([
      existing,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), budgetMs)
        timer.unref?.()
      })
    ]).finally(() => clearTimeout(timer))
  }
  // Publish before awaiting to collapse bursts; convert spawn rejection to transient or the cached rejection wedges WSL until restart.
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
      // Discard transient null promises so cooldown and larger-budget escape can permit a new probe.
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
  // Undefined means default distro; a separate all flag avoids evicting every distro on default Refresh.
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
