import { resolve } from 'path'
import { getRepoExecutionHostId } from '../../shared/execution-host'
import type { TaskSourceContext } from '../../shared/task-source-context'
import type { Repo } from '../../shared/types'
import type { Store } from '../persistence'

export type GiteaRepoSelectorArgs = {
  repoPath: string
  repoId?: string | null
  sourceContext?: TaskSourceContext | null
}

function findRegisteredGiteaRepo(args: GiteaRepoSelectorArgs, store: Store): Repo | undefined {
  const sourceRepoId =
    args.sourceContext?.provider === 'gitea' ? args.sourceContext.repoId?.trim() : null
  const repoId = args.repoId?.trim() || sourceRepoId || null
  if (repoId) {
    const repo = store.getRepo(repoId)
    if (repo) {
      return repo
    }
  }
  const resolvedRepoPath = resolve(args.repoPath)
  return store.getRepos().find((r) => resolve(r.path) === resolvedRepoPath)
}

// Why: mirror gitlab.ts assertRegisteredRepo — handlers must never operate on a
// path the user hasn't registered as a repo (filesystem-auth boundary). The
// source-context host check stops a task fetched on one machine from mutating a
// same-path repo on another.
export function assertRegisteredRepo(args: GiteaRepoSelectorArgs, store: Store): Repo {
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

export function repoConnectionId(repo: Repo): string | null {
  return repo.connectionId ?? null
}
