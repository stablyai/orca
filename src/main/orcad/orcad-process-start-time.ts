/**
 * A process's start time as orcad's identity records carry it (instance lock, managed stop).
 *
 * Windows reuses PIDs aggressively and `getProcessStartedAtMs` answers null there, so a PID
 * alone would be the whole identity. The process-tree addon orcad's Windows slot stages reads
 * the kernel creation time for one PID without a table snapshot or a PowerShell spawn.
 * Null still means "cannot say": callers must never read it as proof of exit.
 */
import {
  getProcessStartedAtMs,
  START_TIME_TOLERANCE_MS,
  startTimesWithinTolerance
} from '../daemon/daemon-process-start-time'
import { readWindowsProcessCreationTime } from '../windows/windows-process-table'

export function readOrcadProcessStartedAtMs(pid: number): number | null {
  return process.platform === 'win32'
    ? readWindowsProcessCreationTime(pid)
    : getProcessStartedAtMs(pid)
}

/** Fails open on an unknown time on either side: an unprovable mismatch keeps the holder. */
export function orcadProcessStartTimeMatches(pid: number, expected: number | null): boolean {
  return startTimesWithinTolerance(
    readOrcadProcessStartedAtMs(pid),
    expected,
    START_TIME_TOLERANCE_MS
  )
}
