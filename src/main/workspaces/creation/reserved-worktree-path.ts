import type { Repo } from '../../../shared/repo-types'
import { composeWorktreeId } from '../../../shared/worktree/id'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import { findPendingWorktreeRemovalConflict } from '../removal/worktree-removal-table'

/** Paths Orca still owns after Git deleted the checkout: a removal still settling, or an archived workspace. */
export function isWorktreePathReserved(
  store: { getWorktreeMeta?: (worktreeId: string) => WorktreeMeta | undefined } | undefined,
  repo: Pick<Repo, 'id' | 'path'>,
  worktreePath: string
): boolean {
  return Boolean(
    findPendingWorktreeRemovalConflict(repo.path, { worktreePath }) ||
    store?.getWorktreeMeta?.(composeWorktreeId(repo.id, worktreePath))?.archivedCheckout
  )
}
