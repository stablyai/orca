import type { Worktree } from '../../shared/worktree/types'
import { getPersistedWorkspaceCleanupActivityAt } from '../../shared/workspace-cleanup'
import { isWorkspaceInactiveForCleanup } from './workspace-cleanup-candidate'

/**
 * Which worktrees a broad (non-targeted) cleanup scan is allowed to emit.
 *
 * Why: a client that has not opted into the full workspace list still renders
 * the suggestion-only views, so the host must keep publishing exactly the rows
 * it always did — inactive, non-main, non-folder worktrees — or an older client
 * is flooded with rows it has no view for.
 */
export function shouldScanBroadWorkspaceCleanupWorktree(args: {
  includeAllWorkspaces: boolean
  repoIsFolder: boolean
  worktree: Worktree
  scannedAt: number
}): boolean {
  const { includeAllWorkspaces, repoIsFolder, worktree, scannedAt } = args
  if (includeAllWorkspaces) {
    return true
  }
  if (repoIsFolder || worktree.isMainWorktree) {
    return false
  }
  // Why: persisted stamps only; the filesystem read that refines them is the
  // expensive part this pre-filter exists to avoid.
  return isWorkspaceInactiveForCleanup(
    {
      isArchived: worktree.isArchived,
      lastActivityAt: getPersistedWorkspaceCleanupActivityAt(worktree)
    },
    scannedAt
  )
}
