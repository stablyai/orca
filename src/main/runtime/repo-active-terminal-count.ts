import { getRepoIdFromWorktreeId } from '../../shared/worktree-id'

export type ActivePtyRecord = {
  worktreeId: string
  connected: boolean
}

/**
 * Counts live (connected) PTY sessions whose worktree belongs to the repo.
 *
 * Why: mirrors `listTerminals`' notion of a "live terminal" — a connected PTY
 * record. Leaves without a backing connected PTY are intentionally excluded so
 * the count matches what `orca terminal list` would show as active. Extracted as
 * a pure function so the unregister fail-closed guard is unit-testable without
 * spinning up a full runtime + PTY harness.
 */
export function countActiveRepoTerminals(ptys: Iterable<ActivePtyRecord>, repoId: string): number {
  let count = 0
  for (const pty of ptys) {
    if (pty.connected && getRepoIdFromWorktreeId(pty.worktreeId) === repoId) {
      count++
    }
  }
  return count
}
