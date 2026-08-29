import type { Repo } from '../../../src/shared/repo-types'
import {
  getExecutionHostLabel,
  getLocalExecutionHostLabel,
  getRepoExecutionHostId,
  parseExecutionHostId
} from '../../../src/shared/execution-host'
import {
  getProjectIdentityKey,
  getProjectProviderIdentity
} from '../../../src/shared/project-host-setup-projection'

type WorkspaceRepo = Pick<Repo, 'id' | 'displayName' | 'path'> &
  Partial<
    Pick<Repo, 'connectionId' | 'executionHostId' | 'upstream' | 'repoIcon' | 'gitRemoteIdentity'>
  >

export type NewWorkspaceProjectOption<TRepo extends WorkspaceRepo> = {
  id: string
  label: string
  detail?: string
  repo: TRepo
}

export type NewWorkspaceRunTargetOption<TRepo extends WorkspaceRepo> = {
  id: string
  label: string
  detail: string
  repo: TRepo
}

export function buildNewWorkspaceProjectOptions<TRepo extends WorkspaceRepo>(
  repos: readonly TRepo[]
): NewWorkspaceProjectOption<TRepo>[] {
  const options = new Map<string, NewWorkspaceProjectOption<TRepo>>()
  const hostIdsByProject = new Map<string, Set<string>>()
  for (const repo of repos) {
    const id = getProjectIdentityKey(repo)
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

export function getNewWorkspaceRunTarget(
  repo: WorkspaceRepo,
  localPlatform: NodeJS.Platform | null = null
): {
  label: string
  detail: string
} {
  const hostId = getRepoExecutionHostId(repo)
  const host = parseExecutionHostId(hostId)
  const hostLabel = getExecutionHostLabel(hostId)
  if (host?.kind === 'ssh') {
    return { label: `SSH · ${hostLabel}`, detail: repo.path }
  }
  if (host?.kind === 'runtime') {
    return { label: `Remote · ${hostLabel}`, detail: repo.path }
  }
  return {
    label: localPlatform ? getLocalExecutionHostLabel(localPlatform) : 'This computer',
    detail: repo.path
  }
}

export function buildNewWorkspaceRunTargetOptions<TRepo extends WorkspaceRepo>(
  repos: readonly TRepo[],
  projectId: string | null,
  localPlatform: NodeJS.Platform | null = null
): NewWorkspaceRunTargetOption<TRepo>[] {
  if (!projectId) {
    return []
  }
  const options = new Map<string, NewWorkspaceRunTargetOption<TRepo>>()
  for (const repo of repos) {
    if (getProjectIdentityKey(repo) !== projectId) {
      continue
    }
    const hostId = getRepoExecutionHostId(repo)
    if (!options.has(hostId)) {
      options.set(hostId, {
        id: repo.id,
        ...getNewWorkspaceRunTarget(repo, localPlatform),
        repo
      })
    }
  }
  return [...options.values()]
}
