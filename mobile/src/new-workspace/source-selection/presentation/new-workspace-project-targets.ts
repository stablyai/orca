import type { Repo } from '../../../../../src/shared/repository/repo-types'
import {
  canonicalExecutionHostId,
  getRepoExecutionHostId,
  parseExecutionHostId,
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
  hostId?: string
  lastActivityAt?: number
  isArchived?: boolean
}

// A repo id names one repo per host, so a row counts for a repo only on the host that listed it.
function isActivityOfRepo(row: NewWorkspaceProjectActivity, repo: WorkspaceRepo): boolean {
  if (row.repoId !== repo.id) {
    return false
  }
  const repoHostId = getRepoExecutionHostId(repo)
  if (row.hostId) {
    return canonicalExecutionHostId(row.hostId) === canonicalExecutionHostId(repoHostId)
  }
  // The desktop's own catalog rows carry no host; a server's rows always do.
  return parseExecutionHostId(repoHostId)?.kind !== 'runtime'
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
  const rowsByRepoId = new Map<string, NewWorkspaceProjectActivity[]>()
  for (const row of worktrees) {
    // Archived rows are out of sight on the host list, so they do not make a project recent.
    if (!row.isArchived && (row.lastActivityAt ?? 0) > 0) {
      const rows = rowsByRepoId.get(row.repoId)
      if (rows) {
        rows.push(row)
      } else {
        rowsByRepoId.set(row.repoId, [row])
      }
    }
  }
  const latestByProjectId = new Map<string, number>()
  for (const repo of repos) {
    const projectId = getProjectIdentityKey(repo)
    for (const row of rowsByRepoId.get(repo.id) ?? []) {
      const at = row.lastActivityAt ?? 0
      if (isActivityOfRepo(row, repo) && at > (latestByProjectId.get(projectId) ?? 0)) {
        latestByProjectId.set(projectId, at)
      }
    }
  }
  const rankOf = (option: TOption) => {
    const ts = latestByProjectId.get(option.id) ?? 0
    return { hasActivity: ts > 0, ts }
  }
  return [...options].sort((a, b) => compareRecentRank(rankOf(a), rankOf(b)))
}

/** Lists options in a given id order; options it does not name follow in their own order. */
export function orderNewWorkspaceProjectsByIds<TOption extends { id: string }>(
  options: readonly TOption[],
  orderedIds: readonly string[]
): TOption[] {
  const position = new Map(orderedIds.map((id, index) => [id, index]))
  const positionOf = (option: TOption) => position.get(option.id) ?? orderedIds.length
  return [...options].sort((a, b) => positionOf(a) - positionOf(b))
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
