import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { userInfo } from 'node:os'

const MACOS_LOGIN_PATH = '/usr/bin/login'
const MACOS_ENV_PATH = '/usr/bin/env'
const MACOS_PRINTF_PATH = '/usr/bin/printf'
const LOGIN_PREFLIGHT_TIMEOUT_MS = 500
const LOGIN_PREFLIGHT_MARKER = 'ORCA_LOGIN_PREFLIGHT_OK'
const LOGIN_PREFLIGHT_MAX_BUFFER_BYTES = 1024

/**
 * Env escape hatch to force the plain (unwrapped) spawn. Set to `1`/`true` if a
 * user's environment misbehaves under login(1); terminals fall back to today's
 * direct-spawn behavior.
 */
const DISABLE_ENV_VAR = 'ORCA_DISABLE_MACOS_LOGIN_SHELL'

let cachedLoginPreflightResult: boolean | null = null
let loginPreflightInFlight: Promise<boolean> | null = null

function isDisabledByEnv(): boolean {
  const value = process.env[DISABLE_ENV_VAR]
  return value === '1' || value === 'true'
}

function runLoginPreflight(username: string, accountHome: string): Promise<boolean> {
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
          // login(1) can return zero after an EOF-driven failed prompt, so only the
          // requested child program's output plus a clean exit proves PAM accepted it.
          resolve(error === null && stdout === LOGIN_PREFLIGHT_MARKER)
        }
      )
      // Why: login(1) must see immediate EOF, not an interactive pipe, so a PAM
      // rejection exits instead of waiting at `login:` until the timeout.
      child.stdin?.end()
    } catch {
      resolve(false)
    }
  })
}

function loginPreflightSucceeds(username: string, accountHome: string): Promise<boolean> {
  if (cachedLoginPreflightResult !== null) {
    return Promise.resolve(cachedLoginPreflightResult)
  }
  if (!loginPreflightInFlight) {
    // Why: simultaneous pane restores share one PAM child instead of multiplying
    // subprocesses at exactly the point terminal startup is already busiest.
    loginPreflightInFlight = runLoginPreflight(username, accountHome).then((result) => {
      cachedLoginPreflightResult = result
      if (!result) {
        console.warn('[pty] macOS login(1) preflight failed; spawning shells directly')
      }
      return result
    })
  }
  return loginPreflightInFlight
}

/**
 * Resolves the one-time PAM capability check before a fresh PTY is spawned.
 * Callers await this at their async request boundary so existing terminals and
 * the Electron main thread remain responsive while login(1) runs.
 */
export async function prepareMacosTccLoginShell(): Promise<void> {
  if (process.platform !== 'darwin' || isDisabledByEnv()) {
    return
  }
  if (cachedLoginPreflightResult !== null) {
    return
  }
  if (!existsSync(MACOS_LOGIN_PATH)) {
    return
  }

  let username: string
  let accountHome: string
  try {
    const account = userInfo()
    username = account.username
    accountHome = account.homedir
  } catch {
    return
  }
  if (!username || !accountHome) {
    return
  }
  await loginPreflightSucceeds(username, accountHome)
}

export function resetMacosLoginShellPreflightForTests(): void {
  cachedLoginPreflightResult = null
  loginPreflightInFlight = null
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
