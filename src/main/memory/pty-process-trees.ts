import { collectSubtree, type ProcIndex, type ProcRow } from './process-index'
import type { PtyRegistration } from './pty-registry'

/** One root's live process subtree, minus processes an earlier root already claimed. */
export function claimProcessTree(
  index: ProcIndex,
  rootPid: number,
  claimed: Set<number>
): ProcRow[] {
  const rows: ProcRow[] = []
  for (const pid of collectSubtree(index, rootPid, claimed)) {
    const row = index.byPid.get(pid)
    if (!row || claimed.has(pid)) {
      continue
    }
    claimed.add(pid)
    rows.push(row)
  }
  return rows
}

/** Processes init adopted that kept this group, with their subtrees: what a group's leader backgrounded. */
export function claimOrphanedGroup(
  index: ProcIndex,
  groupId: number,
  claimed: Set<number>
): ProcRow[] {
  return (index.orphansByGroup?.get(groupId) ?? []).flatMap((pid) =>
    claimProcessTree(index, pid, claimed)
  )
}

/** Each local PTY's live process subtree; overlapping trees are attributed once, in registration order. */
export function claimPtyProcessTrees(
  index: ProcIndex,
  ptys: readonly PtyRegistration[],
  claimed = new Set<number>()
): { pty: PtyRegistration; rows: ProcRow[] }[] {
  return ptys.map((pty) => ({
    pty,
    rows: pty.pid != null ? claimProcessTree(index, pty.pid, claimed) : []
  }))
}
