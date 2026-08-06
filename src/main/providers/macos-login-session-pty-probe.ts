import { execFile, type ExecFileException } from 'node:child_process'
import { existsSync } from 'node:fs'

const MACOS_EXPECT_PATH = '/usr/bin/expect'
const LOGIN_PREFLIGHT_MARKER = 'ORCA_LOGIN_PREFLIGHT_OK'
const LOGIN_PROBE_USERNAME_ENV = 'ORCA_LOGIN_PROBE_USERNAME'
// Why: expect owns the PTY without adding a long-lived native handle to the daemon.
const EXPECT_LOGIN_PROBE_SCRIPT =
  'log_user 1; ' +
  'spawn -noecho /usr/bin/login -flpq $env(ORCA_LOGIN_PROBE_USERNAME) /usr/bin/printf ORCA_LOGIN_PREFLIGHT_OK; ' +
  'send "\\004"; expect eof; wait; exit 0'

export type LoginPreflightOutcome = {
  ok: boolean
  conclusive: boolean
  reason: 'accepted' | 'rejected' | 'timeout' | 'error'
}

export function classifyLoginPreflightError(error: ExecFileException): LoginPreflightOutcome {
  // Why: a probe killed by our bound proves nothing about PAM and must not stick.
  if (error.killed || error.code === 'ETIMEDOUT') {
    return { ok: false, conclusive: false, reason: 'timeout' }
  }
  // Why: a natural nonzero exit is login(1)'s conclusive rejection verdict.
  if (typeof error.code === 'number') {
    return { ok: false, conclusive: true, reason: 'rejected' }
  }
  return { ok: false, conclusive: false, reason: 'error' }
}

/** Runs the login-session oracle under a real PTY when the pipe probe cannot decide. */
export function runMacosLoginSessionPtyProbe(
  username: string,
  accountHome: string,
  timeoutMs: number,
  maxOutputBytes: number,
  signal?: AbortSignal
): Promise<LoginPreflightOutcome> {
  if (!existsSync(MACOS_EXPECT_PATH)) {
    return Promise.resolve({ ok: false, conclusive: false, reason: 'error' })
  }
  return new Promise((resolve) => {
    try {
      const child = execFile(
        MACOS_EXPECT_PATH,
        ['-c', EXPECT_LOGIN_PROBE_SCRIPT],
        {
          cwd: accountHome,
          encoding: 'utf8',
          env: { ...process.env, [LOGIN_PROBE_USERNAME_ENV]: username },
          killSignal: 'SIGKILL',
          maxBuffer: maxOutputBytes,
          signal,
          timeout: timeoutMs
        },
        (error, stdout) => {
          if (error !== null) {
            // Why: a nonzero expect exit can be its own Tcl/PTY failure, not PAM authority.
            resolve(
              error.killed || error.code === 'ETIMEDOUT'
                ? { ok: false, conclusive: false, reason: 'timeout' }
                : { ok: false, conclusive: false, reason: 'error' }
            )
            return
          }
          resolve(
            stdout.includes(LOGIN_PREFLIGHT_MARKER)
              ? { ok: true, conclusive: true, reason: 'accepted' }
              : { ok: false, conclusive: true, reason: 'rejected' }
          )
        }
      )
      child.stdin?.end()
    } catch {
      resolve({ ok: false, conclusive: false, reason: 'error' })
    }
  })
}
