/**
 * A process's identity as orcad's records carry it (instance lock, managed stop).
 *
 * Windows reuses PIDs aggressively and `getProcessStartedAtMs` answers null there, so a PID
 * alone would be the whole identity. The process-tree addon orcad's Windows slot stages reads
 * the kernel creation time for one PID without a table snapshot or a PowerShell spawn.
 * Linux derives wall-clock start time from `/proc/stat` btime, which drifts (WSL2, NTP slews),
 * so there the kernel start ticks plus boot id are the identity and wall time is only a hint.
 * Null still means "cannot say": callers must never read it as proof of exit.
 */
import { readFileSync, statSync } from 'node:fs'
import { parseLinuxStartTicks } from '../agent-hooks/managed-hook-owner-identity'
import {
  getProcessStartedAtMs,
  START_TIME_TOLERANCE_MS,
  startTimesWithinTolerance
} from '../daemon/daemon-process-start-time'
import { readWindowsProcessCreationTime } from '../windows/windows-process-table'

export type OrcadProcessIncarnation = { linuxStartTicks: string; bootId: string }

/** What a lock or stop request recorded; the incarnation is absent from older writers. */
export type OrcadRecordedIdentity = {
  startedAtMs: number | null
  linuxStartTicks?: string
  bootId?: string
  /** The lock's identity: the holder's POSIX uid as a decimal string, or a Windows username. */
  identity?: string
}

/**
 * `differs` proves the PID now names another process. `unproven` is a wall-clock disagreement
 * that proves nothing, because the clock it was derived from can drift.
 */
export type OrcadProcessIdentityVerdict = 'matches' | 'differs' | 'unknown' | 'unproven'

export type OrcadProcessIdentityReaders = {
  startedAtMs?: (pid: number) => number | null
  incarnation?: (pid: number) => OrcadProcessIncarnation | null
  ownerUid?: (pid: number) => number | null
  platform?: NodeJS.Platform
}

export function readOrcadProcessStartedAtMs(pid: number): number | null {
  return process.platform === 'win32'
    ? readWindowsProcessCreationTime(pid)
    : getProcessStartedAtMs(pid)
}

/** Linux only: `/proc/<pid>/stat` field 22 and the kernel boot id, neither tied to a clock. */
export function readOrcadProcessIncarnation(pid: number): OrcadProcessIncarnation | null {
  if (process.platform !== 'linux') {
    return null
  }
  try {
    const linuxStartTicks = parseLinuxStartTicks(readFileSync(`/proc/${pid}/stat`, 'utf8'))
    const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
    return linuxStartTicks && /^\d+$/.test(linuxStartTicks) && bootId
      ? { linuxStartTicks, bootId }
      : null
  } catch {
    return null
  }
}

/** Linux: the uid owning `/proc/<pid>`, which is the process's effective uid, or root if non-dumpable. */
export function readOrcadProcessOwnerUid(pid: number): number | null {
  try {
    return statSync(`/proc/${pid}`).uid
  } catch {
    return null
  }
}

/** Linux: the live process's short command name, for telling the user what holds a PID. */
export function readOrcadProcessName(pid: number): string | null {
  try {
    const name = readFileSync(`/proc/${pid}/comm`, 'utf8')
      .trim()
      .replace(/[^\x20-\x7e]/g, '?')
    return name || null
  } catch {
    return null
  }
}

function readLinuxOverflowUid(): number {
  try {
    const uid = Number(readFileSync('/proc/sys/kernel/overflowuid', 'utf8').trim())
    return Number.isSafeInteger(uid) ? uid : 65534
  } catch {
    return 65534
  }
}

/**
 * orcad never changes uid, so a PID owned by another uid is proof of reuse. Root and the overflow
 * uid prove nothing: /proc shows a non-dumpable process as root, and an unmapped root as overflow.
 */
function ownerProvesAnotherProcess(
  pid: number,
  recorded: OrcadRecordedIdentity,
  readers: OrcadProcessIdentityReaders
): boolean {
  if (!recorded.identity || !/^\d+$/.test(recorded.identity)) {
    return false
  }
  const owner = (readers.ownerUid ?? readOrcadProcessOwnerUid)(pid)
  return (
    owner !== null &&
    owner !== 0 &&
    owner !== Number(recorded.identity) &&
    owner !== readLinuxOverflowUid()
  )
}

export function recordedOrcadProcessIncarnation(
  recorded: OrcadRecordedIdentity
): OrcadProcessIncarnation | null {
  return recorded.linuxStartTicks && recorded.bootId
    ? { linuxStartTicks: recorded.linuxStartTicks, bootId: recorded.bootId }
    : null
}

/** Prefers the recorded incarnation; wall time decides only for records that lack one. */
export function compareOrcadProcessIdentity(
  pid: number,
  recorded: OrcadRecordedIdentity,
  readers: OrcadProcessIdentityReaders = {}
): OrcadProcessIdentityVerdict {
  const expected = recordedOrcadProcessIncarnation(recorded)
  if (expected) {
    const actual = (readers.incarnation ?? readOrcadProcessIncarnation)(pid)
    if (!actual) {
      return 'unknown'
    }
    return actual.bootId === expected.bootId && actual.linuxStartTicks === expected.linuxStartTicks
      ? 'matches'
      : 'differs'
  }
  const actual = (readers.startedAtMs ?? readOrcadProcessStartedAtMs)(pid)
  if (actual === null || recorded.startedAtMs === null) {
    return 'unknown'
  }
  if (startTimesWithinTolerance(actual, recorded.startedAtMs, START_TIME_TOLERANCE_MS)) {
    return 'matches'
  }
  // Windows and macOS report a stored creation time; Linux recomputes it from a drifting btime.
  if ((readers.platform ?? process.platform) !== 'linux') {
    return 'differs'
  }
  return ownerProvesAnotherProcess(pid, recorded, readers) ? 'differs' : 'unproven'
}
