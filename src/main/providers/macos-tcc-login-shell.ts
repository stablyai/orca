import { runProcess } from '@orca/process-host'
import { existsSync } from 'node:fs'
import { userInfo } from 'node:os'
import { basename } from 'node:path'
import {
  runMacosLoginSessionPtyProbe,
  type LoginPreflightOutcome
} from './macos-login-session-pty-probe'

export type { LoginPreflightOutcome } from './macos-login-session-pty-probe'

export const MACOS_LOGIN_PATH = '/usr/bin/login'
const MACOS_BASH_PATH = '/bin/bash'
const MACOS_PRINTF_PATH = '/usr/bin/printf'
const LOGIN_SHELL_TRAMPOLINE = 'export SHELL="$1"; shift; exec -l -- "$@"'
const DIRECT_SHELL_TRAMPOLINE = 'export SHELL="$1"; shift; exec -- "$@"'
const LOGIN_PREFLIGHT_TIMEOUT_MS = 500
// Off the spawn path, the death watch can outwait a slow PAM stack without delaying terminal creation.
const LOGIN_SESSION_WATCH_PROBE_TIMEOUT_MS = 4_000
const LOGIN_PREFLIGHT_MARKER = 'ORCA_LOGIN_PREFLIGHT_OK'
const LOGIN_PREFLIGHT_MAX_BUFFER_BYTES = 1024
const LOGIN_PREFLIGHT_RETRY_BASE_MS = 5_000
const LOGIN_PREFLIGHT_RETRY_MAX_MS = 5 * 60_000
// Long-lived daemons must recheck rejected PAM capability rather than disable attribution forever (#9756).
const LOGIN_PREFLIGHT_REJECTED_REVALIDATE_MS = 30 * 60_000

const DISABLE_ENV_VAR = 'ORCA_DISABLE_MACOS_LOGIN_SHELL'

// Cache only actual PAM verdicts; timeout, output-cap and spawn failures remain retryable.
let cachedLoginPreflightResult: boolean | null = null
let cachedRejectionAtMs: number | null = null
let loginPreflightInFlight: Promise<LoginPreflightOutcome> | null = null
let transientLoginPreflightFailure: { failureCount: number; retryAtMs: number } | null = null
let loginPreflightCacheEpoch = 0
let loginSessionProbeInFlight = false
let loginSessionAcceptedInProcess = false

function isDisabledByEnv(): boolean {
  const value = process.env[DISABLE_ENV_VAR]
  return value === '1' || value === 'true'
}

function loginPreflightRetryDelayMs(failureCount: number): number {
  return Math.min(
    LOGIN_PREFLIGHT_RETRY_MAX_MS,
    LOGIN_PREFLIGHT_RETRY_BASE_MS * 2 ** Math.max(0, failureCount - 1)
  )
}

// Pipes can differ from production PTYs; later wrapper spawn failures still degrade to a direct shell.
async function runLoginPreflight(
  username: string,
  accountHome: string,
  timeoutMs = LOGIN_PREFLIGHT_TIMEOUT_MS,
  signal?: AbortSignal
): Promise<LoginPreflightOutcome> {
  try {
    const result = await runProcess({
      program: MACOS_LOGIN_PATH,
      args: ['-flpq', username, MACOS_PRINTF_PATH, LOGIN_PREFLIGHT_MARKER],
      // Detached daemons may outlive their worktree; probe from the account home.
      cwd: accountHome,
      maxOutputBytes: LOGIN_PREFLIGHT_MAX_BUFFER_BYTES,
      signal,
      timeoutMs
    })
    if (result.timedOut) {
      return { ok: false, conclusive: false, reason: 'timeout' }
    }
    if (result.code === null) {
      return { ok: false, conclusive: false, reason: 'error' }
    }
    if (result.code !== 0) {
      return { ok: false, conclusive: true, reason: 'rejected' }
    }
    // login(1) can return zero after failed EOF prompting; require clean exit plus child marker.
    return result.stdout === LOGIN_PREFLIGHT_MARKER
      ? { ok: true, conclusive: true, reason: 'accepted' }
      : { ok: false, conclusive: true, reason: 'rejected' }
  } catch {
    return { ok: false, conclusive: false, reason: 'error' }
  }
}

async function verifyRejectedLoginPreflightUnderPty(
  username: string,
  accountHome: string,
  outcome: LoginPreflightOutcome
): Promise<LoginPreflightOutcome> {
  if (outcome.ok || !outcome.conclusive) {
    return outcome
  }
  const ptyOutcome = await runMacosLoginSessionPtyProbe(
    username,
    accountHome,
    LOGIN_PREFLIGHT_TIMEOUT_MS,
    LOGIN_PREFLIGHT_MAX_BUFFER_BYTES
  )
  // Why: a pipe-sensitive PAM stack must not override the production-shaped PTY oracle.
  return ptyOutcome.conclusive ? ptyOutcome : outcome
}

function expireStaleRejectedVerdict(): void {
  if (
    cachedLoginPreflightResult === false &&
    cachedRejectionAtMs !== null &&
    Date.now() - cachedRejectionAtMs >= LOGIN_PREFLIGHT_REJECTED_REVALIDATE_MS
  ) {
    cachedLoginPreflightResult = null
    cachedRejectionAtMs = null
  }
}

function cachedOutcome(): LoginPreflightOutcome | null {
  if (cachedLoginPreflightResult === null) {
    return null
  }
  return cachedLoginPreflightResult
    ? { ok: true, conclusive: true, reason: 'accepted' }
    : { ok: false, conclusive: true, reason: 'rejected' }
}

function cacheConclusiveLoginPreflightOutcome(outcome: LoginPreflightOutcome): void {
  if (outcome.ok) {
    cachedRejectionAtMs = null
    loginSessionAcceptedInProcess = true
  } else if (cachedLoginPreflightResult !== false || cachedRejectionAtMs === null) {
    // Why: periodic health probes must not extend one rejected verdict forever.
    cachedRejectionAtMs = Date.now()
  }
  cachedLoginPreflightResult = outcome.ok
  transientLoginPreflightFailure = null
}

function loginPreflightSucceeds(
  username: string,
  accountHome: string
): Promise<LoginPreflightOutcome> {
  const cached = cachedOutcome()
  if (cached) {
    return Promise.resolve(cached)
  }
  if (!loginPreflightInFlight) {
    const cacheEpoch = loginPreflightCacheEpoch
    // Coalesce pane restores so startup bursts share one PAM subprocess.
    loginPreflightInFlight = runLoginPreflight(username, accountHome).then(async (pipeOutcome) => {
      const outcome = await verifyRejectedLoginPreflightUnderPty(username, accountHome, pipeOutcome)
      // Environmental failures cannot become cached PAM verdicts; retry through bounded backoff.
      const mayUpdateCache = !loginSessionProbeInFlight && cacheEpoch === loginPreflightCacheEpoch
      if (outcome.conclusive && mayUpdateCache) {
        cacheConclusiveLoginPreflightOutcome(outcome)
      } else if (!outcome.conclusive && mayUpdateCache) {
        const failureCount = (transientLoginPreflightFailure?.failureCount ?? 0) + 1
        transientLoginPreflightFailure = {
          failureCount,
          retryAtMs: Date.now() + loginPreflightRetryDelayMs(failureCount)
        }
      }
      if (!outcome.ok) {
        console.warn('[pty] macOS login(1) preflight failed; spawning shells directly')
      }
      // Release the in-flight slot so future spawns can retry inconclusive outcomes.
      loginPreflightInFlight = null
      return outcome
    })
  }
  return loginPreflightInFlight
}

/** Await asynchronously to keep main responsive; null means no probe ran.
 * Rejections expire; accepted state changes through the health watch. Return outcomes for detached-daemon telemetry. */
export async function prepareMacosTccLoginShell(): Promise<LoginPreflightOutcome | null> {
  if (process.platform !== 'darwin' || isDisabledByEnv()) {
    return null
  }
  expireStaleRejectedVerdict()
  if (cachedLoginPreflightResult !== null) {
    return null
  }
  // Why: a persistently hung probe must not add 500 ms and a subprocess to every terminal spawn.
  if (transientLoginPreflightFailure && Date.now() < transientLoginPreflightFailure.retryAtMs) {
    return null
  }
  if (!existsSync(MACOS_LOGIN_PATH)) {
    return null
  }

  let username: string
  let accountHome: string
  try {
    const account = userInfo()
    username = account.username
    accountHome = account.homedir
  } catch {
    return null
  }
  if (!username || !accountHome) {
    return null
  }
  return loginPreflightSucceeds(username, accountHome)
}

export function resetMacosLoginShellPreflightForTests(): void {
  cachedLoginPreflightResult = null
  cachedRejectionAtMs = null
  loginPreflightInFlight = null
  transientLoginPreflightFailure = null
  loginPreflightCacheEpoch = 0
  loginSessionProbeInFlight = false
  loginSessionAcceptedInProcess = false
}

/** Fresh death-watch check bypasses spawn cache/backoff and updates conclusive verdicts (#7936).
 * Ambiguous results or rejection after prior acceptance require PTY confirmation; null means wrapping does not apply. */
export async function probeMacosLoginSessionAlive(
  signal?: AbortSignal
): Promise<LoginPreflightOutcome | null> {
  if (process.platform !== 'darwin' || isDisabledByEnv() || !existsSync(MACOS_LOGIN_PATH)) {
    return null
  }
  let username: string
  let accountHome: string
  try {
    const account = userInfo()
    username = account.username
    accountHome = account.homedir
  } catch {
    return null
  }
  if (!username || !accountHome) {
    return null
  }
  // Why: reuse the startup warmup when present, and fence older spawn-path results from restoring a stale verdict.
  const existingPreflight = loginPreflightInFlight
  loginSessionProbeInFlight = true
  loginPreflightCacheEpoch++
  let outcome: LoginPreflightOutcome
  try {
    outcome = await (existingPreflight ??
      runLoginPreflight(username, accountHome, LOGIN_SESSION_WATCH_PROBE_TIMEOUT_MS, signal))
    if (!outcome.ok && !signal?.aborted && (!outcome.conclusive || loginSessionAcceptedInProcess)) {
      outcome = await runMacosLoginSessionPtyProbe(
        username,
        accountHome,
        LOGIN_SESSION_WATCH_PROBE_TIMEOUT_MS,
        LOGIN_PREFLIGHT_MAX_BUFFER_BYTES,
        signal
      )
    }
  } finally {
    // Why: invalidate spawn probes started during this fresh check before they can overwrite its newer verdict.
    loginPreflightCacheEpoch++
    loginSessionProbeInFlight = false
  }
  if (outcome.conclusive) {
    cacheConclusiveLoginPreflightOutcome(outcome)
  }
  return outcome
}

/** login(1) reports its own status, losing shell exit codes/signals; wrapped outcomes must be unknown (STA-4536). */
export function hostReportsChildExitStatus(file: string): boolean {
  return file !== MACOS_LOGIN_PATH
}

/** login(1) gives signed terminal CLIs independent TCC grants; positional trampoline args cannot become shell source. */
export function wrapShellSpawnForMacosTccAttribution(
  file: string,
  args: string[],
  env?: Record<string, string | undefined>
): { file: string; args: string[] } {
  if (process.platform !== 'darwin') {
    return { file, args }
  }
  if (file === MACOS_LOGIN_PATH || isDisabledByEnv()) {
    return { file, args }
  }
  if (!existsSync(MACOS_LOGIN_PATH)) {
    return { file, args }
  }

  let username: string
  try {
    username = userInfo().username
  } catch {
    return { file, args }
  }
  if (!username) {
    return { file, args }
  }
  // Unprepared/rejected hosts still need usable shells; fresh-spawn callers prepare asynchronously first.
  if (cachedLoginPreflightResult !== true) {
    return { file, args }
  }

  const shellEnvValue = env?.SHELL || file
  // Login argv[0] disables Bash --rcfile; the Orca rcfile already implements login startup.
  const trampoline =
    basename(file).toLowerCase() === 'bash' && args.includes('--rcfile')
      ? DIRECT_SHELL_TRAMPOLINE
      : LOGIN_SHELL_TRAMPOLINE

  // -p blocks inherited BASH_ENV and imported functions before the fixed positional trampoline.
  return {
    file: MACOS_LOGIN_PATH,
    args: [
      '-flpq',
      username,
      MACOS_BASH_PATH,
      '--noprofile',
      '--norc',
      '-p',
      '-c',
      trampoline,
      'orca-tcc-login',
      shellEnvValue,
      file,
      ...args
    ]
  }
}
