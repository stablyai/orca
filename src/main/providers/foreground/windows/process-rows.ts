import {
  collectDescendantsFromIndex,
  getProcessTableIndex
} from '../../../../shared/process-observation/tables/process-table-index'
import {
  readWindowsProcessIdentityTableFresh,
  readWindowsProcessTable,
  readWindowsProcessTableFresh,
  resetWindowsProcessTableForTests,
  type WindowsProcessIdentityRow,
  type WindowsProcessRow as NativeWindowsProcessRow
} from '../../../windows/windows-process-table'

import { orphansBornAfterSpawn } from './exited-root-orphans'

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
    ...(row.creationTimeMs !== undefined ? { creationTimeMs: row.creationTimeMs } : {})
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
  /** The root was absent from a fresh table; candidates are its surviving orphans and can only prove presence. */
  rootExited?: true
}

export async function queryWindowsPaneProcessInventory(
  rootPid: number,
  options: {
    fresh?: boolean
    anchorPid?: number
    /** Opts in to orphans of an exited root; only those born after the pane's spawn are returned. */
    exitedRootPaneSpawnedAtMs?: number
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
    options.anchorPid !== undefined ? (index.byPid.get(options.anchorPid) ?? null) : null
  // Missing roots may indicate stale/filtered snapshots, never observed absence of children.
  if (!index.byPid.has(rootPid)) {
    // A pane root can exit while the agent it started keeps the console alive (Windows keeps the
    // dead parent's pid on the orphans). A fresh table still shows those orphans, which callers may
    // use as evidence of presence; an empty or stale read stays unavailable.
    const spawnedAt = options.exitedRootPaneSpawnedAtMs
    if (options.fresh !== true || spawnedAt === undefined) {
      return null
    }
    const orphans = orphansBornAfterSpawn(collectDescendantsFromIndex(index, rootPid), spawnedAt)
    if (orphans.length === 0) {
      return null
    }
    return { candidates: orphans.sort((a, b) => b.depth - a.depth), anchorRow, rootExited: true }
  }
  return {
    candidates: collectDescendantsFromIndex(index, rootPid).sort((a, b) => b.depth - a.depth),
    anchorRow
  }
}

export function resetWindowsProcessRowsSnapshotForTests(): void {
  resetWindowsProcessTableForTests()
}
