import { realpathSync } from 'node:fs'
import type { Repo } from '../shared/repo-types'
import type { GitWorktreeInfo } from '../shared/worktree/types'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../shared/execution-host'
import { areWorktreePathsEqual, dedupeWorktreesByPath } from './ipc/worktree-path-comparison'

function stillNamesRegisteredCheckout(repo: Repo, gitRoot: string): boolean {
  if (areWorktreePathsEqual(repo.path, gitRoot)) {
    return true
  }
  if (getRepoExecutionHostId(repo) !== LOCAL_EXECUTION_HOST_ID) {
    return false
  }
  try {
    // A symlink may have been retargeted since the upgrade.
    return areWorktreePathsEqual(realpathSync(repo.path), realpathSync(gitRoot))
  } catch {
    return false
  }
}

export function preserveFolderUpgradeWorktreePath(
  repo: Repo,
  worktrees: GitWorktreeInfo[]
): GitWorktreeInfo[] {
  const gitRoot = repo.folderUpgradeGitRootPath
  if (
    repo.kind !== 'git' ||
    typeof gitRoot !== 'string' ||
    !gitRoot ||
    !stillNamesRegisteredCheckout(repo, gitRoot)
  ) {
    return worktrees
  }
  // Apply after raw Git caches: this repo's locator must not leak into another registration.
  return dedupeWorktreesByPath(
    worktrees.map((worktree) =>
      areWorktreePathsEqual(worktree.path, gitRoot) ? { ...worktree, path: repo.path } : worktree
    )
  )
}
