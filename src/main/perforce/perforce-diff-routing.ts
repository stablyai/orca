import type { GitDiffResult } from '../../shared/git-diff-compare-types'
import { isFolderRepo } from '../../shared/repo-kind'
import type { Store } from '../persistence'
import { getLocalRepoForRegisteredWorktree } from '../ipc/local-worktree-runtime-options'
import { isPerforceWorkspace } from './perforce-detection'
import { getPerforceDiff } from './perforce-status'

/** Perforce workspaces are registered as folders, so their diffs come from p4 instead of git; null means not Perforce. */
export async function getPerforceFolderDiff(
  store: Store,
  requestedPath: string,
  worktreePath: string,
  filePath: string
): Promise<GitDiffResult | null> {
  const repo = getLocalRepoForRegisteredWorktree(store, requestedPath, worktreePath)
  if (!repo || !isFolderRepo(repo) || !(await isPerforceWorkspace(worktreePath))) {
    return null
  }
  return getPerforceDiff(worktreePath, filePath)
}
