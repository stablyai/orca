/**
 * Whether a scope under the systemd `--user` manager lives at least as long as the caller.
 *
 * Without lingering, systemd stops `user@<uid>.service` — and every `orca-daemon-*.scope` in it —
 * shortly after the user's last login session closes. A caller in a system unit or an SSH
 * session's `session-N.scope` outlives that, so moving the daemon into the user manager would
 * shorten its life (#24201). A caller already inside the user manager (a desktop app scope)
 * dies with it anyway, so the scope costs it nothing.
 */
import { readFileSync } from 'node:fs'
import { runProcessSync, type ProcessResult } from '../../shared/child-process/run-process'

const LINGER_PROBE_TIMEOUT_MS = 2_000

export type LingerProbe = (
  uid: number,
  timeoutMs: number
) => Pick<ProcessResult, 'code' | 'timedOut' | 'stdout'>

function runLoginctlLingerProbe(
  uid: number,
  timeoutMs: number
): Pick<ProcessResult, 'code' | 'timedOut' | 'stdout'> {
  return runProcessSync({
    program: 'loginctl',
    args: ['show-user', String(uid), '-p', 'Linger', '--value'],
    stdio: ['ignore', 'pipe', 'ignore'],
    timeoutMs
  })
}

/** The path field of one `/proc/<pid>/cgroup` line (`id:controllers:path`); '' when absent. */
export function cgroupPathFromProcLine(line: string): string {
  return line.split(':').slice(2).join(':').trim()
}

/** True when any of this process's cgroup paths sits inside the uid's user manager. */
export function cgroupIsInsideUserManager(contents: string, uid: number): boolean {
  const unit = `/user@${uid}.service`
  return contents.split('\n').some((line) => {
    const path = cgroupPathFromProcLine(line)
    return path.endsWith(unit) || path.includes(`${unit}/`)
  })
}

export type UserManagerLifetimeProbeOptions = {
  uid?: number | null
  cgroupPath?: string
  runLingerProbe?: LingerProbe
  log?: (message: string) => void
}

/** Fails closed: an unreadable cgroup plus an unknown linger state means "not durable". */
export function userManagerOutlivesCaller(options: UserManagerLifetimeProbeOptions = {}): boolean {
  const uid = options.uid !== undefined ? options.uid : (process.getuid?.() ?? null)
  if (uid === null) {
    return false
  }
  try {
    if (
      cgroupIsInsideUserManager(
        readFileSync(options.cgroupPath ?? '/proc/self/cgroup', 'utf8'),
        uid
      )
    ) {
      return true
    }
  } catch {
    // Unreadable membership proves nothing; linger alone decides.
  }
  let lingering = false
  try {
    const probe = (options.runLingerProbe ?? runLoginctlLingerProbe)(uid, LINGER_PROBE_TIMEOUT_MS)
    lingering = probe.code === 0 && !probe.timedOut && probe.stdout.trim() === 'yes'
  } catch {
    // loginctl missing or unstartable.
  }
  if (!lingering) {
    ;(options.log ?? console.warn)(
      '[daemon] daemon-scope-unavailable: linger off; the terminal daemon stays in this ' +
        "process's cgroup. Run `loginctl enable-linger` so terminals survive a service restart."
    )
  }
  return lingering
}
