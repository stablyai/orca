import { worktreeIdsEqual } from '../../../../shared/worktree/id'
import {
  ptyInList,
  type PtyList,
  type RuntimePtyWorktreeRecord
} from '../records/runtime-terminal-state-records'
import {
  worktreePtyBelongsToHost,
  type WorktreePtyHostFence
} from '../../workspaces/removal/worktree-pty-host-fence'

/** The terminals a worktree stop targets in one list: every pane's terminal plus every connected PTY
 *  record. */
export function collectWorktreePtyIds(
  leaves: Iterable<{ worktreeId: string; ptyId: string | null }>,
  ptysById: ReadonlyMap<string, RuntimePtyWorktreeRecord>,
  worktreeId: string,
  hostFence: WorktreePtyHostFence,
  list: PtyList | 'every',
  includeDisconnected = false
): Set<string> {
  const ptyIds = new Set<string>()
  for (const leaf of leaves) {
    if (
      worktreeIdsEqual(leaf.worktreeId, worktreeId) &&
      leaf.ptyId &&
      ptyInList(ptysById.get(leaf.ptyId), list) &&
      worktreePtyBelongsToHost(leaf.ptyId, ptysById.get(leaf.ptyId)?.connectionId, hostFence)
    ) {
      ptyIds.add(leaf.ptyId)
    }
  }
  for (const pty of ptysById.values()) {
    if (
      worktreeIdsEqual(pty.worktreeId, worktreeId) &&
      !pty.worktreeInferredFromCwd &&
      ptyInList(pty, list) &&
      (includeDisconnected || pty.connected) &&
      worktreePtyBelongsToHost(pty.ptyId, pty.connectionId, hostFence)
    ) {
      ptyIds.add(pty.ptyId)
    }
  }
  return ptyIds
}

/** Drops PTYs whose workspace only a cwd guess named; worktree-scoped stops never act on one (#36716). */
export function withoutCwdGuesses(
  ptysById: ReadonlyMap<string, RuntimePtyWorktreeRecord>,
  ptyIds: ReadonlySet<string>
): Set<string> {
  return new Set([...ptyIds].filter((ptyId) => !ptysById.get(ptyId)?.worktreeInferredFromCwd))
}
