import { readFileSync } from 'node:fs'
import { runProcessSync } from '../../../shared/child-process/run-process'
import {
  getProcessStartedAtMs,
  parseLinuxProcStartTicks
} from '../../daemon/daemon-process-start-time'

let bootIdentity: string | null | undefined
let ownProcessIdentity: string | null | undefined

/** A kernel boot UUID survives hostname changes without conflating machines sharing a profile. */
export function profileStateAccessBootIdentity(): string | null {
  if (bootIdentity !== undefined) {
    return bootIdentity
  }
  bootIdentity = null
  try {
    if (process.platform === 'linux') {
      bootIdentity = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || null
    } else if (process.platform === 'darwin') {
      const result = runProcessSync({
        program: '/usr/sbin/sysctl',
        args: ['-n', 'kern.bootsessionuuid'],
        timeoutMs: 1_000,
        maxOutputBytes: 1024
      })
      bootIdentity = result.code === 0 ? result.stdout.trim() || null : null
    }
  } catch {
    // Unavailable identity leaves the conservative hostname and PID checks in force.
  }
  return bootIdentity
}

export function profileStateAccessProcessIdentity(pid: number): string | null {
  if (pid !== process.pid) {
    return readProcessIdentity(pid)
  }
  if (ownProcessIdentity === undefined) {
    ownProcessIdentity = readProcessIdentity(pid)
  }
  return ownProcessIdentity
}

function readProcessIdentity(pid: number): string | null {
  if (process.platform === 'linux') {
    try {
      const ticks = parseLinuxProcStartTicks(readFileSync(`/proc/${pid}/stat`, 'utf8'))
      return Number.isSafeInteger(ticks) && ticks >= 0 ? `linux-start-ticks:${ticks}` : null
    } catch {
      return null
    }
  }
  const startedAtMs = getProcessStartedAtMs(pid)
  return startedAtMs === null ? null : `wall-time-ms:${startedAtMs}`
}
