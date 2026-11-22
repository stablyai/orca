import { collectSubtree, type ProcIndex, type ProcRow } from './process-index'
import type { PtyRegistration } from './pty-registry'

/** Each local PTY's live process subtree; overlapping trees are attributed once, in registration order. */
export function claimPtyProcessTrees(
  index: ProcIndex,
  ptys: readonly PtyRegistration[]
): { pty: PtyRegistration; rows: ProcRow[] }[] {
  const claimed = new Set<number>()
  return ptys.map((pty) => {
    const rows: ProcRow[] = []
    if (pty.pid != null) {
      for (const pid of collectSubtree(index, pty.pid, claimed)) {
        const row = index.byPid.get(pid)
        if (!row || claimed.has(pid)) {
          continue
        }
        claimed.add(pid)
        rows.push(row)
      }
    }
    return { pty, rows }
  })
}
