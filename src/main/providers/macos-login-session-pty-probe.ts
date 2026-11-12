import { runProcess } from '@orca/process-host'
import { existsSync } from 'node:fs'

const MACOS_EXPECT_PATH = '/usr/bin/expect'
const LOGIN_PREFLIGHT_MARKER = 'ORCA_LOGIN_PREFLIGHT_OK'
const LOGIN_PROBE_USERNAME_ENV = 'ORCA_LOGIN_PROBE_USERNAME'
// expect owns the probe PTY without leaving a long-lived native handle in the daemon.
// login(1) ignores a closed PTY's SIGHUP, so expect kills it on runProcess's SIGTERM (#30806).
// Trap only after spawn: before it, exp_pid is 0 and would signal our whole process group.
const EXPECT_LOGIN_PROBE_SCRIPT =
  'log_user 1; ' +
  'spawn -noecho /usr/bin/login -flpq $env(ORCA_LOGIN_PROBE_USERNAME) /usr/bin/printf ORCA_LOGIN_PREFLIGHT_OK; ' +
  'trap {catch {exec /bin/kill -KILL [exp_pid]}; exit 1} SIGTERM; ' +
  'send "\\004"; expect eof; wait; exit 0'

export type LoginPreflightOutcome = {
  ok: boolean
  conclusive: boolean
  reason: 'accepted' | 'rejected' | 'timeout' | 'error'
}

/** Runs the login-session oracle under a real PTY when the pipe probe cannot decide. */
export async function runMacosLoginSessionPtyProbe(
  username: string,
  accountHome: string,
  timeoutMs: number,
  maxOutputBytes: number,
  signal?: AbortSignal
): Promise<LoginPreflightOutcome> {
  if (!existsSync(MACOS_EXPECT_PATH)) {
    return { ok: false, conclusive: false, reason: 'error' }
  }
  try {
    const result = await runProcess({
      program: MACOS_EXPECT_PATH,
      args: ['-c', EXPECT_LOGIN_PROBE_SCRIPT],
      cwd: accountHome,
      env: { ...process.env, [LOGIN_PROBE_USERNAME_ENV]: username },
      killOnOutputLimit: true,
      maxOutputBytes,
      signal,
      timeoutMs
    })
    if (result.timedOut) {
      return { ok: false, conclusive: false, reason: 'timeout' }
    }
    // Tcl/PTY failures are inconclusive, never PAM rejection proof.
    if (result.code !== 0 || result.outputTruncated) {
      return { ok: false, conclusive: false, reason: 'error' }
    }
    return result.stdout.includes(LOGIN_PREFLIGHT_MARKER)
      ? { ok: true, conclusive: true, reason: 'accepted' }
      : { ok: false, conclusive: true, reason: 'rejected' }
  } catch {
    return { ok: false, conclusive: false, reason: 'error' }
  }
}
