import { runProcess } from '../../shared/child-process/run-process'
import { existsSync } from 'node:fs'
import { userInfo } from 'node:os'
import { basename } from 'node:path'
import {
  runMacosLoginSessionPtyProbe,
  type LoginPreflightOutcome
} from './macos-login-session-pty-probe'

export type { LoginPreflightOutcome } from './macos-login-session-pty-probe'

const MACOS_LOGIN_PATH = '/usr/bin/login'
const MACOS_BASH_PATH = '/bin/bash'
const MACOS_PRINTF_PATH = '/usr/bin/printf'
const LOGIN_SHELL_TRAMPOLINE = 'export SHELL="$1"; shift; exec -l -- "$@"'
const DIRECT_SHELL_TRAMPOLINE = 'export SHELL="$1"; shift; exec -- "$@"'
const LOGIN_PREFLIGHT_TIMEOUT_MS = 500
// Why: the death-watch probe runs off the spawn path, so it can afford a bound
// that outlasts a PAM stack answering slowly rather than misreading it as a hang.
const LOGIN_SESSION_WATCH_PROBE_TIMEOUT_MS = 4_000
const LOGIN_PREFLIGHT_MARKER = 'ORCA_LOGIN_PREFLIGHT_OK'
const LOGIN_PREFLIGHT_MAX_BUFFER_BYTES = 1024
const LOGIN_PREFLIGHT_RETRY_BASE_MS = 5_000
const LOGIN_PREFLIGHT_RETRY_MAX_MS = 5 * 60_000
// Why: daemons live for weeks across app updates, so a rejected verdict must not
// disable TCC attribution forever; re-verify on a slow cadence (#9756).
const LOGIN_PREFLIGHT_REJECTED_REVALIDATE_MS = 30 * 60_000

/**
 * Env escape hatch to force the plain (unwrapped) spawn. Set to `1`/`true` if a
 * user's environment misbehaves under login(1); terminals fall back to today's
 * direct-spawn behavior.
 */
const DISABLE_ENV_VAR = 'ORCA_DISABLE_MACOS_LOGIN_SHELL'

/**
 * Result of one PAM probe. `conclusive` marks a real PAM verdict (accept or
 * reject) that may be cached; an inconclusive probe (our own timeout/SIGKILL,
 * maxBuffer, or spawn error) proves nothing about PAM and must not stick.
 */
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

// Fidelity limit: the probe runs over pipes while production shells run under a
// real PTY, so a tty-sensitive PAM stack could diverge. It fails safe — a probe
// pass with a prod failure only degrades to today's direct spawn (no wrapper).
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
      // Why: detached daemons can outlive their launch worktree. The PAM
      // probe must not inherit a deleted cwd before PTY spawn repairs it.
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
    // login(1) can return zero after an EOF-driven failed prompt, so only the
    // requested child program's output plus a clean exit proves PAM accepted it.
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
    // Why: simultaneous pane restores share one PAM child instead of multiplying
    // subprocesses at exactly the point terminal startup is already busiest.
    loginPreflightInFlight = runLoginPreflight(username, accountHome).then(async (pipeOutcome) => {
      const outcome = await verifyRejectedLoginPreflightUnderPty(username, accountHome, pipeOutcome)
      // Why: cache only a conclusive PAM verdict; a killed/timed-out probe is
      // environmental and must be retried next spawn, not stuck forever (F1).
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
      // Why: release the in-flight slot so an inconclusive probe can re-run on the
      // next spawn instead of pinning every terminal to the degraded outcome.
      loginPreflightInFlight = null
      return outcome
    })
  }
  return loginPreflightInFlight
}

/**
 * Resolves the cached PAM capability check before a fresh PTY is spawned.
 * Accepted spawn verdicts stay cached unless the login-session watch observes
 * a newer state; rejected verdicts are re-verified after
 * {@link LOGIN_PREFLIGHT_REJECTED_REVALIDATE_MS}.
 * Callers await this at their async request boundary so existing terminals and
 * the Electron main thread remain responsive while login(1) runs.
 *
 * Returns the probe outcome when a probe actually ran this call, or `null` when
 * short-circuited (non-macOS, disabled, already cached, no login binary). The
 * daemon uses the return to emit a structured degrade record, since detached
 * daemons destroy stderr and never surface the console.warn above (F2).
 */
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

/**
 * Fresh PAM probe for login-session death detection (#7936): bypasses the
 * cached verdict and the transient backoff, and writes any conclusive verdict
 * back into the cache — so a daemon whose login session died stops wrapping
 * spawns in `login(1)` (which would only mint "Login incorrect" zombies) even
 * before retirement completes. Escalates ambiguous probes—and negative probes
 * after this process accepted a login session—to the production-shaped PTY
 * oracle. Returns null when the wrapper doesn't apply.
 */
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

/**
 * Wrap a macOS shell spawn in `/usr/bin/login -flpq <user> …` so terminal children
 * get their own TCC identity instead of collapsing into Orca's bundle id — signed
 * CLIs like `op` otherwise re-prompt every launch because tccd attributes the grant
 * to Orca and never persists it (#6996, #8985).
 *
 * A clean bash trampoline restores SHELL after login(1) overwrites it, then replaces
 * itself with the configured shell. Values stay positional so custom paths and
 * arguments are never interpreted as shell source.
 *
 * No-op off macOS, when already wrapped, when disabled via {@link DISABLE_ENV_VAR},
 * or when the login(1) PAM preflight rejects this process's user.
 */
/**
 * Whether a PTY spawned on `file` reports its own child's exit status.
 *
 * login(1) forks the shell, waits, then exits with its own status — it forwards
 * neither the shell's exit code nor its signal. Proved with node-pty: a raw
 * `sh -c 'exit 42'` reports `{exitCode: 42}` and a self-SIGKILL reports
 * `{signal: 9}`, while the same commands behind this wrapper both report
 * `{exitCode: 0, signal: 0}`. Callers must not read a status from a wrapped
 * spawn — say `unknown` instead (STA-4536).
 */
export function hostReportsChildExitStatus(file: string): boolean {
  return file !== MACOS_LOGIN_PATH
}

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
  // Why: an unprepared or failed host must fail open to a usable direct shell;
  // production fresh-spawn boundaries await prepareMacosTccLoginShell first.
  if (cachedLoginPreflightResult !== true) {
    return { file, args }
  }

  const shellEnvValue = env?.SHELL || file
  // Why: Bash ignores --rcfile when argv[0] marks it as a login shell; Orca's
  // rcfile already reproduces login startup and must remain the active wrapper.
  const trampoline =
    basename(file).toLowerCase() === 'bash' && args.includes('--rcfile')
      ? DIRECT_SHELL_TRAMPOLINE
      : LOGIN_SHELL_TRAMPOLINE

  // Why: -p blocks login(1)-preserved BASH_ENV and imported functions before the fixed trampoline runs.
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
