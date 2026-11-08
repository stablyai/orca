import type { Repo } from '../../../src/shared/repo-types'
import { getRepoExecutionHostId } from '../../../src/shared/execution-host'
import { getProjectIdentityKey } from '../../../src/shared/project-host-setup-projection'
import { matchProjectHostQuery } from '../../../src/shared/project-host-query'
import type {
  NewWorkspaceProjectOption,
  NewWorkspaceRunTargetOption
} from './new-workspace-project-targets'

/** Id of a project row narrowed to one host, unique across hosts. */
export function newWorkspaceProjectHostRowId(projectId: string, hostId: string): string {
  return `${projectId}\u0000${hostId}`
}

type SearchRepo = Pick<Repo, 'id' | 'displayName' | 'path'> &
  Partial<Pick<Repo, 'connectionId' | 'executionHostId' | 'upstream' | 'gitRemoteIdentity'>>

/** Projects matching the query; naming a host turns a project into one row per matching host. */
export function searchNewWorkspaceProjectOptions<TRepo extends SearchRepo>(
  options: readonly NewWorkspaceProjectOption<TRepo>[],
  repos: readonly TRepo[],
  query: string,
  hostLabelFor: (repo: TRepo) => string
): NewWorkspaceProjectOption<TRepo>[] {
  if (query.trim() === '') {
    return [...options]
  }
  return options.flatMap((option) => {
    const hostRepos = uniqueHostRepos(repos, option.id)
    const hostLabels = hostRepos.map(hostLabelFor)
    const match = matchProjectHostQuery(query, {
      name: option.label,
      detail: option.detail,
      hostLabels
    })
    if (!match) {
      return []
    }
    if (!match.hostIndexes) {
      return [option]
    }
    // Picking a host-narrowed row also picks that host, so the run target follows the query.
    return match.hostIndexes.map((index) => ({
      ...option,
      id: newWorkspaceProjectHostRowId(option.id, getRepoExecutionHostId(hostRepos[index])),
      detail: hostLabels[index],
      repo: hostRepos[index]
    }))
  })
}

export function searchNewWorkspaceRunTargetOptions<TRepo extends SearchRepo>(
  options: readonly NewWorkspaceRunTargetOption<TRepo>[],
  query: string
): NewWorkspaceRunTargetOption<TRepo>[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  return options.filter((option) => {
    const text = `${option.label} ${option.detail}`.toLowerCase()
    return words.every((word) => text.includes(word))
  })
}

function uniqueHostRepos<TRepo extends SearchRepo>(
  repos: readonly TRepo[],
  projectId: string
): TRepo[] {
  const byHost = new Map<string, TRepo>()
  for (const repo of repos) {
    const hostId = getRepoExecutionHostId(repo)
    if (getProjectIdentityKey(repo) === projectId && !byHost.has(hostId)) {
      byHost.set(hostId, repo)
    }
  }
  return [...byHost.values()]
}

export type NewWorkspaceQuickPick<TRepo extends SearchRepo> = {
  id: string
  label: string
  hostLabel: string
  repo: TRepo
}

/** One row per project and host, so a pick sets both; hostId narrows to that host's checkouts. */
export function quickPickNewWorkspaceTargets<TRepo extends SearchRepo>(
  options: readonly NewWorkspaceProjectOption<TRepo>[],
  repos: readonly TRepo[],
  query: string,
  hostLabelFor: (repo: TRepo) => string,
  hostId: string | null,
  limit: number
): NewWorkspaceQuickPick<TRepo>[] {
  const picks: NewWorkspaceQuickPick<TRepo>[] = []
  for (const option of options) {
    const hostRepos = uniqueHostRepos(repos, option.id)
    const hostLabels = hostRepos.map(hostLabelFor)
    const match = matchProjectHostQuery(query, {
      name: option.label,
      detail: option.detail,
      hostLabels
    })
    if (!match) {
      continue
    }
    const indexes = match.hostIndexes ?? hostRepos.map((_, index) => index)
    for (const index of indexes) {
      const repo = hostRepos[index]
      const repoHostId = getRepoExecutionHostId(repo)
      if (hostId === null || repoHostId === hostId) {
        picks.push({
          id: newWorkspaceProjectHostRowId(option.id, repoHostId),
          label: option.label,
          hostLabel: hostLabels[index],
          repo
        })
      }
    }
  }
  return picks.slice(0, limit)
}

/** The hosts any project is set up on, in first-seen order, for quick host filters. */
export function listNewWorkspaceHosts<TRepo extends SearchRepo>(
  repos: readonly TRepo[],
  hostLabelFor: (repo: TRepo) => string
): { id: string; label: string }[] {
  const hosts = new Map<string, string>()
  for (const repo of repos) {
    const hostId = getRepoExecutionHostId(repo)
    if (!hosts.has(hostId)) {
      hosts.set(hostId, hostLabelFor(repo))
    }
  }
  return [...hosts].map(([id, label]) => ({ id, label }))
}
