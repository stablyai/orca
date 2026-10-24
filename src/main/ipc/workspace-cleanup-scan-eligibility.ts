import type { Worktree } from '../../shared/worktree/types'
import { getPersistedWorkspaceCleanupActivityAt } from '../../shared/workspace-cleanup'
import { isWorkspaceInactiveForCleanup } from './workspace-cleanup-candidate'

/** Preserve suggestion-only broad scans for older clients; full-list coverage requires explicit opt-in. */
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
  // Use persisted stamps before the expensive filesystem activity refinement.
  return isWorkspaceInactiveForCleanup(
    {
      isArchived: worktree.isArchived,
      lastActivityAt: getPersistedWorkspaceCleanupActivityAt(worktree)
    },
    scannedAt
  )
}
