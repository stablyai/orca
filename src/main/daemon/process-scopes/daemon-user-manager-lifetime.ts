/** Outside callers require linger: logout can stop the user manager while their own cgroup survives (#24201). */
import { readFileSync } from 'node:fs'
import { runProcessSync } from '@orca/process-host'
import type { ProcessResult } from '@orca/process-host/process-spec'

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

export function cgroupPathFromProcLine(line: string): string {
  return line.split(':').slice(2).join(':').trim()
}

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
    // An unavailable linger probe cannot establish durable scope ownership.
  }
  if (!lingering) {
    ;(options.log ?? console.warn)(
      '[daemon] daemon-scope-unavailable: linger off; the terminal daemon stays in this ' +
        "process's cgroup. Run `loginctl enable-linger` so terminals survive a service restart."
    )
  }
  return lingering
}
