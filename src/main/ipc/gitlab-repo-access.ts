import { resolve } from 'node:path'
import type { Repo } from '../../shared/repo-types'
import { getRepoExecutionHostId } from '../../shared/execution-host'
import type { TaskSourceContext } from '../../shared/task-source-context'
import type { Store } from '../persistence'
import type { LocalGitExecOptions } from '../gitlab/gitlab-project-ref-resolution'
import { getLocalProjectWorktreeGitOptions } from '../project-runtime-git-options'
import type { HostedReviewExecutionOptions } from '../source-control/hosted-review-git-options'

export type GitLabRepoSelectorArgs = {
  repoPath: string
  repoId?: string | null
  sourceContext?: TaskSourceContext | null
  repoOwnerExecutionHostId?: string
}

function findRegisteredGitLabRepo(args: GitLabRepoSelectorArgs, store: Store): Repo | undefined {
  const sourceRepoId =
    args.sourceContext?.provider === 'gitlab' ? args.sourceContext.repoId?.trim() : null
  const repoId = args.repoId?.trim() || sourceRepoId || null
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
  return store.getRepos().find((r) => resolve(r.path) === resolvedRepoPath)
}

// Why: mirror github.ts assertRegisteredRepo — main-process handlers
// must never operate on a path the user hasn't explicitly registered as
// a repo (filesystem-auth boundary). Source context adds a host check so a
// task fetched from one machine cannot mutate a same-path repo on another.
export function assertRegisteredRepo(args: GitLabRepoSelectorArgs, store: Store): Repo {
  const repo = findRegisteredGitLabRepo(args, store)
  if (!repo) {
    throw new Error('Access denied: unknown repository path')
  }
  if (
    args.sourceContext?.provider === 'gitlab' &&
    args.sourceContext.hostId !== getRepoExecutionHostId(repo)
  ) {
    throw new Error('Access denied: GitLab source host does not match repository host')
  }
  return repo
}

export function repoConnectionId(repo: Repo): string | null {
  return repo.connectionId ?? null
}

export function localGitOptionArgs(store: Store, repo: Repo): [] | [LocalGitExecOptions] {
  const localGitOptions = getLocalProjectWorktreeGitOptions(store, repo)
  return localGitOptions.wslDistro ? [{ wslDistro: localGitOptions.wslDistro }] : []
}

export function hostedReviewOptionArgs(
  store: Store,
  repo: Repo
): [] | [HostedReviewExecutionOptions] {
  const localGitOptions = getLocalProjectWorktreeGitOptions(store, repo)
  return localGitOptions.wslDistro
    ? [{ localGitExecOptions: { wslDistro: localGitOptions.wslDistro } }]
    : []
}
