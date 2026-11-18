import { realpathSync } from 'node:fs'
import { realpathAcrossWslDriveMount } from '../../wsl/filesystem/wsl-unc-drive-fs-path'
import type { Repo } from '../../../shared/repository/repo-types'
import type { GitWorktreeInfo } from '../../../shared/worktree/types'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID
} from '../../../shared/execution-host/execution-host'
import {
  areWorktreePathsEqual,
  dedupeWorktreesByPath
} from '../../git/worktrees/catalog/worktree-path-comparison'

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
  return projectFolderUpgradePath(repo.path, gitRoot, worktrees)
}

export async function preserveFolderUpgradeWorktreePathAsync(
  repo: Repo,
  worktrees: GitWorktreeInfo[]
): Promise<GitWorktreeInfo[]> {
  const gitRoot = repo.folderUpgradeGitRootPath
  if (repo.kind !== 'git' || typeof gitRoot !== 'string' || !gitRoot) {
    return worktrees
  }
  if (!areWorktreePathsEqual(repo.path, gitRoot)) {
    if (getRepoExecutionHostId(repo) !== LOCAL_EXECUTION_HOST_ID) {
      return worktrees
    }
    try {
      const [registered, current] = await Promise.all([
        realpathAcrossWslDriveMount(repo.path),
        realpathAcrossWslDriveMount(gitRoot)
      ])
      if (!areWorktreePathsEqual(registered, current)) {
        return worktrees
      }
    } catch {
      return worktrees
    }
  }
  return projectFolderUpgradePath(repo.path, gitRoot, worktrees)
}

function projectFolderUpgradePath(
  repoPath: string,
  gitRoot: string,
  worktrees: GitWorktreeInfo[]
): GitWorktreeInfo[] {
  // Apply after raw Git caches so locators cannot leak into another registration.
  return dedupeWorktreesByPath(
    worktrees.map((worktree) =>
      areWorktreePathsEqual(worktree.path, gitRoot) ? { ...worktree, path: repoPath } : worktree
    )
  )
}
