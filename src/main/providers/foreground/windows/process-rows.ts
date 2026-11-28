import {
  collectDescendantsFromIndex,
  getProcessTableIndex
} from '../../../../shared/process-observation/tables/process-table-index'
import {
  readWindowsProcessIdentityTableFresh,
  readWindowsProcessTable,
  readWindowsProcessTableFresh,
  type WindowsProcessIdentityRow,
  type WindowsProcessRow as NativeWindowsProcessRow
} from '../../../windows/windows-process-table'

export type WindowsProcessRow = {
  pid: number
  ppid: number
  name: string
  command: string
  creationTimeMs?: number
}

export type WindowsProcessCandidate = WindowsProcessRow & { depth: number }

function toProcessRow(row: NativeWindowsProcessRow): WindowsProcessRow {
  return {
    pid: row.pid,
    ppid: row.ppid,
    name: row.name,
    // Query denial can hide command lines; preserve image-name recognition as fallback.
    command: row.command || row.name,
    ...(typeof row.creationTimeMs === 'number' ? { creationTimeMs: row.creationTimeMs } : {})
  }
}

/** Share projection identity so per-pane reads also reuse the process-table index; rows remain immutable. */
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

/** Ancestry only needs identity rows; requesting unused command lines costs one OpenProcess per row. */
export async function queryWindowsProcessLinksFresh(): Promise<WindowsProcessIdentityRow[]> {
  return readWindowsProcessIdentityTableFresh()
}

export async function queryWindowsProcessDescendants(
  rootPid: number,
  options: { fresh?: boolean } = {}
): Promise<WindowsProcessCandidate[] | null> {
  return (await queryWindowsPaneProcessInventory(rootPid, options))?.candidates ?? null
}

export type WindowsPaneProcessInventory = {
  candidates: WindowsProcessCandidate[]
  /** Full-table anchor catches recycled job-member PIDs orphaned outside the descendant walk. */
  anchorRow: WindowsProcessRow | null
  /** The root exited; candidates are its orphans, which can prove an agent but never a shell. */
  rootExited?: true
}

export async function queryWindowsPaneProcessInventory(
  rootPid: number,
  options: {
    fresh?: boolean
    anchorProcessId?: number
    /** Opts in to an exited root's orphans; only those born after the pane spawn are its own. */
    paneSpawnedAtMs?: number
  } = {}
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
  // Snapshot-shared index avoids per-pane whole-table map builds and linear PID lookups.
  const index = getProcessTableIndex(rows)
  const anchorRow =
    options.anchorProcessId !== undefined
      ? (index.byPid.get(options.anchorProcessId) ?? null)
      : null
  if (index.byPid.has(rootPid)) {
    return {
      candidates: collectDescendantsFromIndex(index, rootPid).sort((a, b) => b.depth - a.depth),
      anchorRow
    }
  }
  const spawnedAt = options.paneSpawnedAtMs
  // Missing roots may indicate stale/filtered snapshots, never observed absence of children.
  if (options.fresh !== true || spawnedAt === undefined) {
    return null
  }
  // Orphans keep the dead root's pid as ppid, which Windows may have reused since an older process held it.
  const orphans = collectDescendantsFromIndex(
    index,
    rootPid,
    (row) => row.ppid === rootPid && (row.creationTimeMs ?? 0) < spawnedAt
  )
  return orphans.length === 0
    ? null
    : { candidates: orphans.sort((a, b) => b.depth - a.depth), anchorRow, rootExited: true }
}
