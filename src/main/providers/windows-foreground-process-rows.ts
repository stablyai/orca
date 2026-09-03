import { collectDescendantsFromIndex, getProcessTableIndex } from '../../shared/process-table-index'
import {
  readWindowsProcessTable,
  readWindowsProcessTableFresh,
  resetWindowsProcessTableForTests,
  type WindowsProcessRow as NativeWindowsProcessRow
} from '../windows/windows-process-table'

export type WindowsProcessRow = {
  pid: number
  ppid: number
  name: string
  command: string
}

export type WindowsProcessCandidate = WindowsProcessRow & { depth: number }

function toProcessRow(row: NativeWindowsProcessRow): WindowsProcessRow {
  return {
    pid: row.pid,
    ppid: row.ppid,
    name: row.name,
    // Why fall back to the image name: a process that denied a query handle has
    // no command line, and callers match on `command` first.
    command: row.command || row.name
  }
}

/**
 * One projection per snapshot identity, mirroring `getProcessTableIndex`.
 *
 * The TTL cache already gives every pane the same native rows array; without
 * this each of them still rebuilt ~1050 row objects, which also handed
 * `getProcessTableIndex` a new array each time and defeated its memo by
 * construction. Keyed weakly, so a projection dies with its snapshot. Rows are
 * shared, never mutated: descendants are copied with their depth, and
 * `anchorRow` is read-only to every caller.
 */
const projectedRows = new WeakMap<readonly NativeWindowsProcessRow[], WindowsProcessRow[]>()

function projectProcessRows(native: readonly NativeWindowsProcessRow[]): WindowsProcessRow[] {
  const cached = projectedRows.get(native)
  if (cached) {
    return cached
  }
  const rows = native.map(toProcessRow)
  projectedRows.set(native, rows)
  return rows
}

/**
 * Rows from a scan that starts after this call.
 *
 * PID-identity checks in teardown must not reuse a cached row — it can predate
 * the very recycle it is meant to detect. Rejects when the table is unreadable,
 * so "unavailable" stays distinguishable from "nothing is running".
 *
 * `readonly` because the projection is shared with every other reader of the
 * same snapshot.
 */
export async function queryWindowsProcessRowsFresh(): Promise<readonly WindowsProcessRow[]> {
  return projectProcessRows(await readWindowsProcessTableFresh())
}

export async function queryWindowsProcessDescendants(
  rootPid: number,
  options: { fresh?: boolean } = {}
): Promise<WindowsProcessCandidate[] | null> {
  return (await queryWindowsPaneProcessInventory(rootPid, options))?.candidates ?? null
}

export type WindowsPaneProcessInventory = {
  candidates: WindowsProcessCandidate[]
  /**
   * Full-table row for `anchorPid`. From the whole snapshot, not the ppid
   * projection: a pane-job member whose creator exited is orphaned out of the
   * descendant walk yet can still hold a recycled anchor pid.
   */
  anchorRow: WindowsProcessRow | null
}

export async function queryWindowsPaneProcessInventory(
  rootPid: number,
  options: { fresh?: boolean; anchorPid?: number } = {}
): Promise<WindowsPaneProcessInventory | null> {
  let rows: WindowsProcessRow[]
  try {
    const native =
      options.fresh === true
        ? await readWindowsProcessTableFresh()
        : await readWindowsProcessTable()
    rows = projectProcessRows(native)
  } catch {
    return null
  }
  // One index per snapshot, shared by every pane inspecting inside the TTL
  // window: `byPid` answers both lookups that used to be linear scans, and
  // `childrenByPpid` replaces a per-call Map rebuild over the whole table.
  const index = getProcessTableIndex(rows)
  // Why: a snapshot that omitted the PTY root may be stale or permission-
  // filtered; only an observed root can authoritatively have no descendants.
  if (!index.byPid.has(rootPid)) {
    return null
  }
  return {
    candidates: collectDescendantsFromIndex(index, rootPid).sort((a, b) => b.depth - a.depth),
    anchorRow: options.anchorPid !== undefined ? (index.byPid.get(options.anchorPid) ?? null) : null
  }
}

/** Test-only: clear the shared snapshot so one case's rows never serve the next. */
export function resetWindowsProcessRowsSnapshotForTests(): void {
  resetWindowsProcessTableForTests()
}
