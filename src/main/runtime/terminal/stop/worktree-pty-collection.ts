import { worktreeIdsEqual } from '../../../../shared/worktree/id'
import type { RuntimePtyWorktreeRecord } from '../../runtime-terminal-state-records'
import { worktreePtyBelongsToHost, type WorktreePtyHostFence } from '../../worktree-pty-host-fence'

/** The terminals a worktree stop targets: every pane's terminal plus every connected PTY record. */
export function collectWorktreePtyIds(
  leaves: Iterable<{ worktreeId: string; ptyId: string | null }>,
  ptysById: ReadonlyMap<string, RuntimePtyWorktreeRecord>,
  worktreeId: string,
  hostFence: WorktreePtyHostFence,
  includeDisconnected = false
): Set<string> {
  const ptyIds = new Set<string>()
  for (const leaf of leaves) {
    if (
      worktreeIdsEqual(leaf.worktreeId, worktreeId) &&
      leaf.ptyId &&
      worktreePtyBelongsToHost(leaf.ptyId, ptysById.get(leaf.ptyId)?.connectionId, hostFence)
    ) {
      ptyIds.add(leaf.ptyId)
    }
  }
  for (const pty of ptysById.values()) {
    if (
      worktreeIdsEqual(pty.worktreeId, worktreeId) &&
      (includeDisconnected || pty.connected) &&
      worktreePtyBelongsToHost(pty.ptyId, pty.connectionId, hostFence)
    ) {
      ptyIds.add(pty.ptyId)
    }
  }
  return ptyIds
}
