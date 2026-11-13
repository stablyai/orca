import type { Repo } from '../../../shared/repo-types'
import { composeWorktreeId, worktreeIdsEqual } from '../../../shared/worktree/id'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import { findPendingWorktreeRemovalConflict } from '../removal/worktree-removal-table'

/** Paths Orca still owns after Git deleted the checkout: a removal still settling, or an archived workspace. */
export function isWorktreePathReserved(
  store: { getAllWorktreeMeta?: () => Record<string, WorktreeMeta> } | undefined,
  repo: Pick<Repo, 'id' | 'path'>,
  worktreePath: string
): boolean {
  if (findPendingWorktreeRemovalConflict(repo.path, { worktreePath })) {
    return true
  }
  // Path spelling differs between Git's ids and computed create paths (Windows separators).
  const candidateId = composeWorktreeId(repo.id, worktreePath)
  return Object.entries(store?.getAllWorktreeMeta?.() ?? {}).some(
    ([worktreeId, meta]) => meta.archivedCheckout && worktreeIdsEqual(worktreeId, candidateId)
  )
}
