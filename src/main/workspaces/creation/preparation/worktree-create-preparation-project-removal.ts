import { worktreePreparationGit } from '../../../git/worktrees/creation/worktree-create-git-executor'
import type { AddWorktreeOptions } from '../../../git/worktrees/worktree-operation-options'
import type { Repo } from '../../../../shared/repo-types'
import { isFolderRepo } from '../../../../shared/repo-kind'
import { getRepoRoutingConnectionId } from '../../../../shared/execution-host'
import { getLocalProjectWorktreeGitOptions } from '../../execution-host/project-runtime-git-options'
import { discardRepoPreparations } from './worktree-create-preparation-pool'
import { preparationPathKey } from './worktree-create-preparation-claim'
import { preparationHostKey } from './worktree-preparation-discard-retry'
import { startStalePreparationCleanup } from './worktree-create-preparation-stale-cleanup'

/** Removal is the last point Orca knows this repo, so reclaim its armed and crash-left checkouts now. */
export function releaseWorktreeCreatePreparationsForRepo(
  store: Parameters<typeof getLocalProjectWorktreeGitOptions>[0],
  repo: Repo
): void {
  if (getRepoRoutingConnectionId(repo) || isFolderRepo(repo)) {
    return
  }
  const repoPathKey = preparationPathKey(repo.path)
  discardRepoPreparations(repoPathKey)
  let options: AddWorktreeOptions
  try {
    options = getLocalProjectWorktreeGitOptions(store, repo)
  } catch {
    // A runtime needing repair cannot run Git, and must not block forgetting its project.
    return
  }
  void worktreePreparationGit.run(() =>
    startStalePreparationCleanup(
      preparationHostKey(repoPathKey, options.wslDistro ?? ''),
      repo.path,
      options
    )
  )
}
