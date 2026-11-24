import { resolve } from 'node:path'
import {
  getRepoExecutionHostId,
  getRepoRoutingConnectionId
} from '../../../shared/execution-host/execution-host'
import type { TaskSourceContext } from '../../../shared/work-items/task-source-context'
import type { Repo } from '../../../shared/repository/repo-types'
import type { Store } from '../../persistence/loading-store/store'
import type { GiteaRepoTarget } from '../../gitea/requests/gitea-repo-target'
import { getLocalProjectWorktreeGitOptions } from '../../workspaces/execution-host/project-runtime-git-options'

export type GiteaRepoSelectorArgs = {
  repoPath: string
  repoId?: string | null
  sourceContext?: TaskSourceContext | null
  repoOwnerExecutionHostId?: string
}

function findRegisteredGiteaRepo(args: GiteaRepoSelectorArgs, store: Store): Repo | undefined {
  const sourceRepoId =
    args.sourceContext?.provider === 'gitea' ? args.sourceContext.repoId?.trim() : null
  const repoId = args.repoId?.trim() || sourceRepoId || null
  const resolvedRepoPath = resolve(args.repoPath)
  if (args.repoOwnerExecutionHostId) {
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
  return store.getRepos().find((r) => resolve(r.path) === resolvedRepoPath)
}

// Require registered paths and the captured host so same-path twins cannot receive cross-host mutations.
export function assertRegisteredGiteaRepo(args: GiteaRepoSelectorArgs, store: Store): Repo {
  if (!args || typeof args.repoPath !== 'string') {
    throw new Error('Access denied: unknown repository path')
  }
  const repo = findRegisteredGiteaRepo(args, store)
  if (!repo) {
    throw new Error('Access denied: unknown repository path')
  }
  if (
    args.sourceContext?.provider === 'gitea' &&
    args.sourceContext.hostId !== getRepoExecutionHostId(repo)
  ) {
    throw new Error('Access denied: Gitea source host does not match repository host')
  }
  return repo
}

export function giteaRepoTarget(args: GiteaRepoSelectorArgs, store: Store): GiteaRepoTarget {
  const repo = assertRegisteredGiteaRepo(args, store)
  return {
    repoPath: repo.path,
    connectionId: getRepoRoutingConnectionId(repo),
    localGitOptions: wslGitOptions(store, repo)
  }
}

function wslGitOptions(store: Store, repo: Repo): GiteaRepoTarget['localGitOptions'] {
  const { wslDistro } = getLocalProjectWorktreeGitOptions(store, repo)
  return wslDistro ? { wslDistro } : undefined
}
