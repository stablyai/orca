import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import type { Repo } from '../../../shared/repo-types'
import { splitWorktreeId } from '../../../shared/worktree/id'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import { areWorktreePathsEqual } from '../../git/worktrees/catalog/worktree-path-comparison'
import { findPendingWorktreeRemovalConflict } from '../removal/worktree-removal-table'

/** Paths Orca still owns after Git deleted the checkout: a removal still settling, or an archived workspace. */
export function isWorktreePathReserved(
  store: { getAllWorktreeMeta?: () => Record<string, WorktreeMeta> } | undefined,
  repo: Pick<Repo, 'path'>,
  worktreePath: string
): boolean {
  if (findPendingWorktreeRemovalConflict(repo.path, { worktreePath })) {
    return true
  }
  // Any project's archive may sit in a shared workspace root; remote hosts' paths are not this disk.
  return Object.entries(store?.getAllWorktreeMeta?.() ?? {}).some(([worktreeId, meta]) => {
    const archivedPath = meta.archivedCheckout && splitWorktreeId(worktreeId)?.worktreePath
    return (
      Boolean(archivedPath) &&
      (!meta.hostId || meta.hostId === LOCAL_EXECUTION_HOST_ID) &&
      areWorktreePathsEqual(archivedPath as string, worktreePath)
    )
  })
}
