import { collectDescendantsFromIndex, getProcessTableIndex } from '../../shared/process-table-index'
import {
  readWindowsProcessIdentityTableFresh,
  readWindowsProcessTable,
  readWindowsProcessTableFresh,
  resetWindowsProcessTableForTests,
  type WindowsProcessIdentityRow,
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
    // Query denial can hide command lines; preserve image-name recognition as fallback.
    command: row.command || row.name
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
  /** Console members outside the descendant walk, e.g. MSYS exec children whose Win32 parent exited. */
  collectConsoleOrphans: (consoleProcessIds: ReadonlySet<number>) => WindowsProcessCandidate[]
}

export function windowsCandidateIsAncestor(
  candidate: WindowsProcessRow,
  other: WindowsProcessRow,
  candidatesByPid: ReadonlyMap<number, WindowsProcessRow>
): boolean {
  let current = candidatesByPid.get(other.ppid)
  while (current) {
    if (current.pid === candidate.pid) {
      return true
    }
    current = candidatesByPid.get(current.ppid)
  }
  return false
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
  // Snapshot-shared index avoids per-pane whole-table map builds and linear PID lookups.
  const index = getProcessTableIndex(rows)
  // Missing roots may indicate stale/filtered snapshots, never observed absence of children.
  if (!index.byPid.has(rootPid)) {
    return null
  }
  const candidates = collectDescendantsFromIndex(index, rootPid).sort((a, b) => b.depth - a.depth)
  return {
    candidates,
    anchorRow:
      options.anchorPid !== undefined ? (index.byPid.get(options.anchorPid) ?? null) : null,
    collectConsoleOrphans: (consoleProcessIds) => {
      const linked = new Set([rootPid, ...candidates.map((candidate) => candidate.pid)])
      const isOrphan = (pid: number): boolean => consoleProcessIds.has(pid) && !linked.has(pid)
      return [...consoleProcessIds].flatMap((pid) => {
        const row = index.byPid.get(pid)
        // Each orphan subtree is collected once, from its topmost console member.
        if (!row || !isOrphan(pid) || isOrphan(row.ppid)) {
          return []
        }
        const subtree = collectDescendantsFromIndex(index, pid, (child) => !isOrphan(child.pid))
        return [
          { ...row, depth: 1 },
          ...subtree.map((child) => ({ ...child, depth: child.depth + 1 }))
        ]
      })
    }
  }
}

export function resetWindowsProcessRowsSnapshotForTests(): void {
  resetWindowsProcessTableForTests()
}
