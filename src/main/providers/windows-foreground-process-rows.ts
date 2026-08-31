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
 * Rows from a scan that starts after this call.
 *
 * PID-identity checks in teardown must not reuse a cached row — it can predate
 * the very recycle it is meant to detect. Rejects when the table is unreadable,
 * so "unavailable" stays distinguishable from "nothing is running".
 */
export async function queryWindowsProcessRowsFresh(): Promise<WindowsProcessRow[]> {
  return (await readWindowsProcessTableFresh()).map(toProcessRow)
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
    rows = native.map(toProcessRow)
  } catch {
    return null
  }
  // Why: a snapshot that omitted the PTY root may be stale or permission-
  // filtered; only an observed root can authoritatively have no descendants.
  if (!rows.some((row) => row.pid === rootPid)) {
    return null
  }
  return {
    candidates: collectDescendants(rows, rootPid).sort((a, b) => b.depth - a.depth),
    anchorRow:
      options.anchorPid !== undefined
        ? (rows.find((row) => row.pid === options.anchorPid) ?? null)
        : null
  }
}

/** Test-only: clear the shared snapshot so one case's rows never serve the next. */
export function resetWindowsProcessRowsSnapshotForTests(): void {
  resetWindowsProcessTableForTests()
}

function collectDescendants<Row extends { pid: number; ppid: number }>(
  rows: Row[],
  rootPid: number
): (Row & { depth: number })[] {
  const childrenByParent = new Map<number, Row[]>()
  for (const row of rows) {
    const children = childrenByParent.get(row.ppid) ?? []
    children.push(row)
    childrenByParent.set(row.ppid, children)
  }

  const descendants: (Row & { depth: number })[] = []
  const stack = (childrenByParent.get(rootPid) ?? []).map((row) => ({ row, depth: 1 }))
  while (stack.length > 0) {
    const { row, depth } = stack.pop()!
    descendants.push({ ...row, depth })
    for (const child of childrenByParent.get(row.pid) ?? []) {
      stack.push({ row: child, depth: depth + 1 })
    }
  }
  return descendants
}
