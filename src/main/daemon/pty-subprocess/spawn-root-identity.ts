import {
  isWindowsProcessStartTimeAvailable,
  readWindowsProcessTableFresh
} from '../../windows/windows-process-table'

/**
 * Spawn-anchored creation time for a fresh Windows PTY root.
 *
 * Why at spawn and not at sweep: by sweep time the root PID may already be
 * recycled, so a lazily captured "baseline" could be the replacement's time
 * and prove nothing. Captured here — microseconds after node-pty returns the
 * pid, while the child is necessarily the process just spawned — the value
 * identifies this root for the rest of its life and lets the tree-kill
 * identity probe tell a recycled PID apart from the original (#10680).
 *
 * Best-effort by design: off-Windows, or where the process table cannot
 * provide creation times, it resolves undefined and callers keep the
 * ancestry-only probe. Never rejects, so a deficient host cannot fail a spawn.
 */
export async function captureSpawnedRootCreationTimeMs(
  rootPid: number,
  deps: {
    isStartTimeAvailable?: () => boolean
    readFreshRows?: () => Promise<readonly { pid: number; creationTimeMs?: number }[]>
  } = {}
): Promise<number | undefined> {
  if (process.platform !== 'win32' || !Number.isInteger(rootPid) || rootPid <= 0) {
    return undefined
  }
  // Why gate on start-time availability instead of reading anyway: without
  // the native creation-time field there is no baseline worth capturing,
  // and the table reader would fall back to a PowerShell scan on deficient
  // hosts — a spawn-time shell fork for no benefit.
  if (!(deps.isStartTimeAvailable ?? isWindowsProcessStartTimeAvailable)()) {
    return undefined
  }
  try {
    const readFreshRows = deps.readFreshRows ?? readWindowsProcessTableFresh
    const row = (await readFreshRows()).find((candidate) => candidate.pid === rootPid)
    return typeof row?.creationTimeMs === 'number' ? row.creationTimeMs : undefined
  } catch {
    return undefined
  }
}
