import { execFile, type ExecFileException } from 'node:child_process'
import { existsSync } from 'node:fs'
import { userInfo } from 'node:os'

const MACOS_LOGIN_PATH = '/usr/bin/login'
const MACOS_ENV_PATH = '/usr/bin/env'
const MACOS_PRINTF_PATH = '/usr/bin/printf'
const LOGIN_PREFLIGHT_TIMEOUT_MS = 500
const LOGIN_PREFLIGHT_MARKER = 'ORCA_LOGIN_PREFLIGHT_OK'
const LOGIN_PREFLIGHT_MAX_BUFFER_BYTES = 1024
const LOGIN_PREFLIGHT_RETRY_BASE_MS = 5_000
const LOGIN_PREFLIGHT_RETRY_MAX_MS = 5 * 60_000

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
export type LoginPreflightOutcome = {
  ok: boolean
  conclusive: boolean
  reason: 'accepted' | 'rejected' | 'timeout' | 'error'
}

let cachedLoginPreflightResult: boolean | null = null
let loginPreflightInFlight: Promise<LoginPreflightOutcome> | null = null
let transientLoginPreflightFailure: { failureCount: number; retryAtMs: number } | null = null

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

function classifyPreflightError(error: ExecFileException): LoginPreflightOutcome {
  // Why: our SIGKILL timeout cap (and maxBuffer, which also kills) is an
  // environmental slow-path, not a PAM verdict — retry, don't cache (F1).
  if (error.killed || error.code === 'ETIMEDOUT') {
    return { ok: false, conclusive: false, reason: 'timeout' }
  }
  // A numeric exit code means login(1) ran to completion and rejected the user
  // (it exits immediately on EOF-driven rejection); that verdict is cacheable.
  if (typeof error.code === 'number') {
    return { ok: false, conclusive: true, reason: 'rejected' }
  }
  // Spawn/EOF/other failure: inconclusive, fail open for this spawn but retry.
  return { ok: false, conclusive: false, reason: 'error' }
}

// Fidelity limit: the probe runs over pipes while production shells run under a
// real PTY, so a tty-sensitive PAM stack could diverge. It fails safe — a probe
// pass with a prod failure only degrades to today's direct spawn (no wrapper).
function runLoginPreflight(username: string, accountHome: string): Promise<LoginPreflightOutcome> {
  return new Promise((resolve) => {
    try {
      const child = execFile(
        MACOS_LOGIN_PATH,
        ['-flpq', username, MACOS_PRINTF_PATH, LOGIN_PREFLIGHT_MARKER],
        {
          // Why: detached daemons can outlive their launch worktree. The PAM
          // probe must not inherit a deleted cwd before PTY spawn repairs it.
          cwd: accountHome,
          encoding: 'utf8',
          // Why: PAM policy can wait indefinitely. Bound both child lifetime and
          // captured diagnostics without blocking the PTY host's event loop.
          killSignal: 'SIGKILL',
          maxBuffer: LOGIN_PREFLIGHT_MAX_BUFFER_BYTES,
          timeout: LOGIN_PREFLIGHT_TIMEOUT_MS
        },
        (error, stdout) => {
          if (error === null) {
            // login(1) can return zero after an EOF-driven failed prompt, so only the
            // requested child program's output plus a clean exit proves PAM accepted it.
            resolve(
              stdout === LOGIN_PREFLIGHT_MARKER
                ? { ok: true, conclusive: true, reason: 'accepted' }
                : { ok: false, conclusive: true, reason: 'rejected' }
            )
            return
          }
          resolve(classifyPreflightError(error))
        }
      )
      // Why: login(1) must see immediate EOF, not an interactive pipe, so a PAM
      // rejection exits instead of waiting at `login:` until the timeout.
      child.stdin?.end()
    } catch {
      resolve({ ok: false, conclusive: false, reason: 'error' })
    }
  })
}

function cachedOutcome(): LoginPreflightOutcome | null {
  if (cachedLoginPreflightResult === null) {
    return null
  }
  return cachedLoginPreflightResult
    ? { ok: true, conclusive: true, reason: 'accepted' }
    : { ok: false, conclusive: true, reason: 'rejected' }
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
    // Why: simultaneous pane restores share one PAM child instead of multiplying
    // subprocesses at exactly the point terminal startup is already busiest.
    loginPreflightInFlight = runLoginPreflight(username, accountHome).then((outcome) => {
      // Why: cache only a conclusive PAM verdict; a killed/timed-out probe is
      // environmental and must be retried next spawn, not stuck forever (F1).
      if (outcome.conclusive) {
        cachedLoginPreflightResult = outcome.ok
        transientLoginPreflightFailure = null
      } else {
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
 * Resolves the one-time PAM capability check before a fresh PTY is spawned.
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
  loginPreflightInFlight = null
  transientLoginPreflightFailure = null
}

/**
 * Wrap a macOS shell spawn in `/usr/bin/login -flpq <user> …` so terminal children
 * get their own TCC identity instead of collapsing into Orca's bundle id — signed
 * CLIs like `op` otherwise re-prompt every launch because tccd attributes the grant
 * to Orca and never persists it (#6996). This mirrors how Terminal.app spawns shells.
 *
 * Why the env(1) interposition: login(1) overwrites SHELL from the account DB even
 * under -p, so `/usr/bin/env SHELL=<shell>` re-asserts the shell Orca actually runs
 * without disturbing login's attribution (skipped when the shell path contains `=`).
 *
 * No-op off macOS, when already wrapped, when disabled via {@link DISABLE_ENV_VAR},
 * or when the login(1) PAM preflight rejects this process's user.
 */
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
  const interposedShellEnv =
    !file.includes('=') && existsSync(MACOS_ENV_PATH)
      ? [MACOS_ENV_PATH, `SHELL=${shellEnvValue}`]
      : []

  return {
    file: MACOS_LOGIN_PATH,
    args: ['-flpq', username, ...interposedShellEnv, file, ...args]
  }
}
