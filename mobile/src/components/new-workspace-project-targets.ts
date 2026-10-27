import type { Repo } from '../../../src/shared/repo-types'
import { getRepoExecutionHostId, type ExecutionHostId } from '../../../src/shared/execution-host'
import {
  projectHostSetupProjectionFromRepos,
  getProjectProviderIdentity
} from '../../../src/shared/project-host-setup-projection'
import { getRepoHostIdentity } from '../../../src/shared/repo-host-identity'
import { getHostContextLabel } from '../../../src/shared/worktree/host-context-labels'

type WorkspaceRepo = Pick<Repo, 'id' | 'displayName' | 'path'> &
  Partial<
    Pick<
      Repo,
      | 'connectionId'
      | 'executionHostId'
      | 'upstream'
      | 'repoIcon'
      | 'gitRemoteIdentity'
      | 'addedAt'
      | 'projectHostSetupMethod'
      | 'kind'
    >
  >

export function getNewWorkspaceProjectIds(
  repos: readonly WorkspaceRepo[]
): ReadonlyMap<string, string> {
  const projection = projectHostSetupProjectionFromRepos(
    repos.map((repo) => ({
      badgeColor: '',
      addedAt: 0,
      ...repo
    }))
  )
  return new Map(
    projection.setups.map((setup, index) => [getRepoHostIdentity(repos[index]), setup.projectId])
  )
}

export type NewWorkspaceProjectOption<TRepo extends WorkspaceRepo> = {
  id: string
  label: string
  detail?: string
  repo: TRepo
}

export type NewWorkspaceRunTargetOption<TRepo extends WorkspaceRepo> = {
  id: string
  hostId: ExecutionHostId
  label: string
  detail: string
  repo: TRepo
}

export function buildNewWorkspaceProjectOptions<TRepo extends WorkspaceRepo>(
  repos: readonly TRepo[],
  projectIds = getNewWorkspaceProjectIds(repos)
): NewWorkspaceProjectOption<TRepo>[] {
  const options = new Map<string, NewWorkspaceProjectOption<TRepo>>()
  const hostIdsByProject = new Map<string, Set<string>>()
  for (const repo of repos) {
    if (!repo.path) {
      continue
    }
    const id = projectIds.get(getRepoHostIdentity(repo))!
    const hostIds = hostIdsByProject.get(id) ?? new Set<string>()
    hostIds.add(getRepoExecutionHostId(repo))
    hostIdsByProject.set(id, hostIds)
    if (!options.has(id)) {
      options.set(id, {
        id,
        label: repo.displayName,
        repo
      })
    }
  }
  return [...options.values()].map((option) => {
    const providerIdentity = getProjectProviderIdentity(option.repo)
    const providerDetail = providerIdentity
      ? `${providerIdentity.owner}/${providerIdentity.repo}`
      : ''
    const hostCount = hostIdsByProject.get(option.id)?.size ?? 0
    const detail = providerDetail || (hostCount > 1 ? `${hostCount} hosts configured` : '')
    return detail ? { ...option, detail } : option
  })
}

/** Named like the host list's badge; the desktop's picker shows the bare host label too. */
export function getNewWorkspaceRunTarget(
  repo: WorkspaceRepo,
  localPlatform: NodeJS.Platform | null = null,
  hostLabelById?: ReadonlyMap<ExecutionHostId, string>
): {
  hostId: ExecutionHostId
  label: string
  detail: string
} {
  const hostId = getRepoExecutionHostId(repo)
  return {
    hostId,
    label: getHostContextLabel(hostId, {
      hostLabelById,
      hostPlatform: localPlatform
    }),
    detail: repo.path
  }
}

export function buildNewWorkspaceRunTargetOptions<TRepo extends WorkspaceRepo>(
  repos: readonly TRepo[],
  projectId: string | null,
  localPlatform: NodeJS.Platform | null = null,
  hostLabelById?: ReadonlyMap<ExecutionHostId, string>,
  projectIds = getNewWorkspaceProjectIds(repos)
): NewWorkspaceRunTargetOption<TRepo>[] {
  if (!projectId) {
    return []
  }
  const options = new Map<string, NewWorkspaceRunTargetOption<TRepo>>()
  for (const repo of repos) {
    if (!repo.path || projectIds.get(getRepoHostIdentity(repo)) !== projectId) {
      continue
    }
    const hostId = getRepoExecutionHostId(repo)
    if (!options.has(hostId)) {
      // Keyed by host: a repo id names one repo per host, so two hosts can share one.
      options.set(hostId, {
        id: hostId,
        ...getNewWorkspaceRunTarget(repo, localPlatform, hostLabelById),
        repo
      })
    }
  }
  return [...options.values()]
}
