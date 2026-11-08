import type { Repo } from '../../../src/shared/repo-types'
import { getRepoExecutionHostId } from '../../../src/shared/execution-host'
import { getProjectIdentityKey } from '../../../src/shared/project-host-setup-projection'
import { matchProjectHostQuery } from '../../../src/shared/project-host-query'
import type {
  NewWorkspaceProjectOption,
  NewWorkspaceRunTargetOption
} from './new-workspace-project-targets'

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
      id: `${option.id}\u0000${getRepoExecutionHostId(hostRepos[index])}`,
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
