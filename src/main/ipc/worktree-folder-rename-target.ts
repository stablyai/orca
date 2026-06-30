import { posix } from 'node:path'
import type { GlobalSettings } from '../../shared/types'
import { WORKTREE_ID_SEPARATOR } from '../../shared/worktree-id'
import { computeWorktreePath } from './worktree-logic'

type WorktreePathSettings = Pick<GlobalSettings, 'nestWorkspaces' | 'workspaceDir'>

export type WorktreeFolderRenamePlan = {
  oldPath: string
  newPath: string
  /** `${repoId}::${newPath}` — what a worktree refresh reports post-move. */
  newWorktreeId: string
}

/**
 * Decide whether (and where) to rename a worktree's on-disk folder so it matches
 * the work-derived branch leaf. Returns null to skip — degrading to "branch +
 * display renamed, folder kept" — when the move would be unsafe or pointless:
 * remote (SSH folder moves aren't mirrored), Windows (the OS locks a directory
 * that is the running agent's cwd), the name already matches, or current path
 * settings would relocate the worktree to a different parent rather than rename
 * it in place. newWorktreeId is built from the same path passed to the move, so
 * it matches the id git reports back after `git worktree move`.
 */
export function planWorktreeFolderRename(args: {
  repoId: string
  repoPath: string
  oldWorktreePath: string
  newLeaf: string
  settings: WorktreePathSettings
  platform: NodeJS.Platform
  isRemote: boolean
}): WorktreeFolderRenamePlan | null {
  if (args.isRemote || args.platform === 'win32') {
    return null
  }
  const newPath = computeWorktreePath(args.newLeaf, args.repoPath, args.settings)
  if (!newPath || newPath === args.oldWorktreePath) {
    return null
  }
  // Why: keep this a pure rename. If path settings changed since creation the
  // computed target could sit under a different parent — moving there would
  // relocate, not rename, so skip rather than surprise the user.
  // posix.dirname is safe here: win32 is filtered out above, so every remaining
  // path (remote/Linux/Mac) uses forward slashes.
  if (posix.dirname(newPath) !== posix.dirname(args.oldWorktreePath)) {
    return null
  }
  return {
    oldPath: args.oldWorktreePath,
    newPath,
    newWorktreeId: `${args.repoId}${WORKTREE_ID_SEPARATOR}${newPath}`
  }
}
