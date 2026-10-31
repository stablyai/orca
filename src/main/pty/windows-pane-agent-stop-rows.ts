import {
  buildProcessTableIndex,
  collectDescendantsFromIndex
} from '../../shared/process-table-index'
import type { ProcessTableRow } from '../../shared/process-table-snapshot'
import {
  readWindowsProcessTableFresh,
  type WindowsProcessRow
} from '../windows/windows-process-table'

export function windowsPaneAgentStopRows(rows: readonly WindowsProcessRow[]): ProcessTableRow[] {
  return rows.map((row) => ({
    pid: row.pid,
    ppid: row.ppid,
    startTime: row.creationTimeMs ? String(row.creationTimeMs) : undefined,
    stat: '',
    command: row.command || row.name
  }))
}

export async function readWindowsPaneAgentStopRows(): Promise<ProcessTableRow[]> {
  return windowsPaneAgentStopRows(await readWindowsProcessTableFresh())
}

export function windowsPaneRows(
  rows: WindowsProcessRow[],
  root: { pid: number; startTime: string }
) {
  const index = buildProcessTableIndex(rows)
  const rootRow = index.byPid.get(root.pid)
  if (index.byPid.size !== rows.length || String(rootRow?.creationTimeMs) !== root.startTime) {
    throw new Error('pane root changed')
  }
  const children = collectDescendantsFromIndex(index, root.pid)
  for (const child of children) {
    const parent = index.byPid.get(child.ppid)
    if (
      !parent ||
      !Number.isSafeInteger(parent.creationTimeMs) ||
      !parent.creationTimeMs ||
      !Number.isSafeInteger(child.creationTimeMs) ||
      !child.creationTimeMs ||
      parent.creationTimeMs > child.creationTimeMs
    ) {
      throw new Error('parent identity unproven')
    }
  }
  return { index, children }
}
