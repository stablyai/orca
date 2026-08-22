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
  executablePath: string
}

export type WindowsProcessCandidate = WindowsProcessRow & { depth: number }

/**
 * Recover the image path from the command line.
 *
 * Why derive rather than query: a separate `ExecutablePath` column cost a
 * `Get-CimInstance` scan, and the command line already begins with the same
 * path — quoted when it contains spaces. Agent matching only uses this as extra
 * text alongside `command`, so a best-effort first token preserves it.
 */
function executablePathFromCommand(command: string): string {
  if (!command) {
    return ''
  }
  if (command.startsWith('"')) {
    const end = command.indexOf('"', 1)
    return end === -1 ? '' : command.slice(1, end)
  }
  const space = command.indexOf(' ')
  return space === -1 ? command : command.slice(0, space)
}

function toProcessRow(row: NativeWindowsProcessRow): WindowsProcessRow {
  return {
    pid: row.pid,
    ppid: row.ppid,
    name: row.name,
    // Why fall back to the image name: a process that denied a query handle has
    // no command line, and callers match on `command` first.
    command: row.command || row.name,
    executablePath: executablePathFromCommand(row.command)
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
  return collectDescendants(rows, rootPid).sort((a, b) => b.depth - a.depth)
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
