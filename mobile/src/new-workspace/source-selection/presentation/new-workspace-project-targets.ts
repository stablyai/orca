import type { Repo } from '../../../../../src/shared/repository/repo-types'
import {
  getRepoExecutionHostId,
  type ExecutionHostId
} from '../../../../../src/shared/execution-host/execution-host'
import {
  getProjectIdentityKey,
  getProjectProviderIdentity
} from '../../../../../src/shared/project/host-setup/project-host-setup-projection'
import { getHostContextLabel } from '../../../../../src/shared/worktree/row-display/host-context-labels'
import { compareRecentRank } from '../../../../../src/shared/sidebar-list/sections/project-section-order'

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
  hostId: ExecutionHostId
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

export type NewWorkspaceProjectActivity = {
  repoId: string
  lastActivityAt?: number
  isArchived?: boolean
}

/** Projects with the newest workspace activity first, as the sidebar's Recent order; the rest keep their order. */
export function orderNewWorkspaceProjectsByRecentActivity<
  TOption extends { id: string },
  TRepo extends WorkspaceRepo
>(
  options: readonly TOption[],
  repos: readonly TRepo[],
  worktrees: readonly NewWorkspaceProjectActivity[]
): TOption[] {
  const latestByRepoId = new Map<string, number>()
  for (const { repoId, lastActivityAt = 0, isArchived } of worktrees) {
    // Archived rows are out of sight on the host list, so they do not make a project recent.
    if (!isArchived && lastActivityAt > (latestByRepoId.get(repoId) ?? 0)) {
      latestByRepoId.set(repoId, lastActivityAt)
    }
  }
  const latestByProjectId = new Map<string, number>()
  for (const repo of repos) {
    const projectId = getProjectIdentityKey(repo)
    const latest = latestByRepoId.get(repo.id) ?? 0
    if (latest > (latestByProjectId.get(projectId) ?? 0)) {
      latestByProjectId.set(projectId, latest)
    }
  }
  const rankOf = (option: TOption) => {
    const ts = latestByProjectId.get(option.id) ?? 0
    return { hasActivity: ts > 0, ts }
  }
  return [...options].sort((a, b) => compareRecentRank(rankOf(a), rankOf(b)))
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
  hostLabelById?: ReadonlyMap<ExecutionHostId, string>
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
