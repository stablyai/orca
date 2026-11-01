import { resolve } from 'node:path'
import { getRepoExecutionHostId } from '../../shared/execution-host'
import type { Repo } from '../../shared/repo-types'
import type { TaskSourceContext } from '../../shared/task-source-context'
import type { Store } from '../persistence'
import { hostedReviewOptionArgs, localGitOptionArgs, repoConnectionId } from './gitlab-repo-access'

export type GiteaRepoSelectorArgs = {
  repoPath: string
  repoId?: string | null
  sourceContext?: TaskSourceContext | null
  repoOwnerExecutionHostId?: string
}

export { hostedReviewOptionArgs, localGitOptionArgs, repoConnectionId }

function findRegisteredGiteaRepo(args: GiteaRepoSelectorArgs, store: Store): Repo | undefined {
  const repoId = args.repoId?.trim() || null
  if (args.repoOwnerExecutionHostId) {
    const resolvedRepoPath = resolve(args.repoPath)
    const matches = store
      .getRepos()
      .filter(
        (repo) =>
          (!repoId || repo.id === repoId) &&
          resolve(repo.path) === resolvedRepoPath &&
          getRepoExecutionHostId(repo) === args.repoOwnerExecutionHostId
      )
    return matches.length === 1 ? matches[0] : undefined
  }
  if (repoId) {
    const repo = store.getRepo(repoId)
    if (repo) {
      return repo
    }
  }
  const resolvedRepoPath = resolve(args.repoPath)
  return store.getRepos().find((repo) => resolve(repo.path) === resolvedRepoPath)
}

// Require the registered path and captured host so same-path twins cannot receive cross-host calls.
export function assertRegisteredGiteaRepo(args: GiteaRepoSelectorArgs, store: Store): Repo {
  const repo = findRegisteredGiteaRepo(args, store)
  if (!repo) {
    throw new Error('Access denied: unknown repository path')
  }
  if (
    args.repoOwnerExecutionHostId &&
    args.repoOwnerExecutionHostId !== getRepoExecutionHostId(repo)
  ) {
    throw new Error('Access denied: Gitea source host does not match repository host')
  }
  return repo
}
