import type { Repo } from '../../../../shared/repo-types'
import { getProjectGroupSubtreeIds } from '../../../../shared/project-groups'
import { isPathInsideOrEqual } from '../../../../shared/cross-platform-path'
import { parseExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree/id'
import { sharesWorktreeLineageBoundary } from '../../../../shared/resolved-worktree-lineage'
import type { Store } from '../../../persistence/loading-store/store'
import type { WorktreeLineage, WorkspaceLineage } from '../../../../shared/worktree/lineage-types'
import {
  createLineageResolutionContext,
  resolveRepoLineageOwner,
  resolveWorktreeLineageOwner
} from './lineage-owner-resolution'
import type {
  LineageFolder,
  LineageOwner,
  LineageResolutionContext
} from './lineage-owner-resolution'

export function getFolderLineageCandidateRepos(
  context: LineageResolutionContext,
  folder: LineageFolder
): Repo[] {
  let groupIds = context.groupSubtreeIdsByRoot.get(folder.projectGroupId)
  if (!groupIds) {
    groupIds = getProjectGroupSubtreeIds(context.groups, folder.projectGroupId)
    context.groupSubtreeIdsByRoot.set(folder.projectGroupId, groupIds)
  }
  const grouped = context.repos.filter(
    (repo) => typeof repo.projectGroupId === 'string' && groupIds.has(repo.projectGroupId)
  )
  const pathRepos = context.repos.filter(
    (repo) =>
      !(typeof repo.projectGroupId === 'string' && groupIds.has(repo.projectGroupId)) &&
      isPathInsideOrEqual(folder.folderPath, repo.path)
  )
  const group = context.groupsById.get(folder.projectGroupId)?.[0]
  const connectionId = folder.connectionId ?? group?.connectionId ?? null
  if (connectionId) {
    return [...grouped, ...pathRepos.filter((repo) => (repo.connectionId ?? null) === connectionId)]
  }
  if (grouped.length === 0) {
    return pathRepos
  }
  if (pathRepos.length === 0) {
    return grouped
  }
  const groupedConnectionIds = new Set(grouped.map((repo) => repo.connectionId ?? null))
  return [
    ...grouped,
    ...pathRepos.filter((repo) => groupedConnectionIds.has(repo.connectionId ?? null))
  ]
}

export function resolveFolderLineageOwner(
  context: LineageResolutionContext,
  folderWorkspaceId: string
): LineageOwner {
  const cached = context.folderOwners.get(folderWorkspaceId)
  if (cached) {
    return cached
  }
  const remember = (owner: LineageOwner): LineageOwner => {
    context.folderOwners.set(folderWorkspaceId, owner)
    return owner
  }
  const folders = context.foldersById.get(folderWorkspaceId) ?? []
  if (folders.length !== 1) {
    return remember({ status: 'ambiguous' })
  }
  const folder = folders[0]
  const groups = context.groupsById.get(folder.projectGroupId) ?? []
  if (groups.length !== 1) {
    return remember({ status: 'ambiguous' })
  }
  const group = groups[0]
  const hosts = new Set<ExecutionHostId>()
  if (folder.connectionId) {
    hosts.add(`ssh:${encodeURIComponent(folder.connectionId)}`)
  }
  if (group.connectionId) {
    hosts.add(`ssh:${encodeURIComponent(group.connectionId)}`)
  }
  if (group.executionHostId) {
    const parsed = parseExecutionHostId(group.executionHostId)
    if (!parsed) {
      return remember({ status: 'ambiguous' })
    }
    hosts.add(parsed.id)
  }
  for (const repo of getFolderLineageCandidateRepos(context, folder)) {
    const owner = resolveRepoLineageOwner(repo)
    if (owner.status !== 'owned') {
      return remember(owner)
    }
    hosts.add(owner.hostId)
  }
  if (hosts.size > 1) {
    return remember({ status: 'contradictory' })
  }
  const hostId = [...hosts][0] ?? LOCAL_EXECUTION_HOST_ID
  return remember(
    parseExecutionHostId(hostId)?.kind === 'runtime'
      ? { status: 'runtime' }
      : { status: 'owned', hostId }
  )
}

export function resolveWorkspaceLineageOwner(
  context: LineageResolutionContext,
  workspaceKey: string
): LineageOwner {
  const cached = context.workspaceOwners.get(workspaceKey)
  if (cached) {
    return cached
  }
  const workspace = parseWorkspaceKey(workspaceKey)
  const owner = !workspace
    ? { status: 'ambiguous' as const }
    : workspace.type === 'worktree'
      ? resolveWorktreeLineageOwner(context, workspace.worktreeId)
      : resolveFolderLineageOwner(context, workspace.folderWorkspaceId)
  context.workspaceOwners.set(workspaceKey, owner)
  return owner
}

/**
 * Whether an owned cross-host edge is one the creation boundary allows (#23290): the same repo and
 * the same defined projectId, mirroring `sharesWorktreeLineageBoundary`. Folder endpoints carry no
 * projectId, so a cross-host row touching a folder never qualifies.
 */
function isProjectScopedCrossHostEdge(
  store: Store,
  child: { worktreeId: string | null; hostId: ExecutionHostId },
  parent: { worktreeId: string | null; hostId: ExecutionHostId }
): boolean {
  if (child.worktreeId === null || parent.worktreeId === null) {
    return false
  }
  return sharesWorktreeLineageBoundary(
    {
      repoId: getRepoIdFromWorktreeId(child.worktreeId),
      hostId: child.hostId,
      projectId: store.getWorktreeMeta(child.worktreeId)?.projectId
    },
    {
      repoId: getRepoIdFromWorktreeId(parent.worktreeId),
      hostId: parent.hostId,
      projectId: store.getWorktreeMeta(parent.worktreeId)?.projectId
    }
  )
}

function worktreeIdForWorkspaceKey(workspaceKey: string): string | null {
  const workspace = parseWorkspaceKey(workspaceKey)
  return workspace?.type === 'worktree' ? workspace.worktreeId : null
}

/**
 * The lineage rows owned by `executionHostId`, or null when ownership cannot be proven. A row
 * belongs to its child's host. A cross-host row is accepted only when it is project-scoped (see
 * `isProjectScopedCrossHostEdge`); any other cross-host row nulls the whole host.
 */
export function filterLineageForHost(
  store: Store,
  executionHostId: ExecutionHostId
): {
  worktreeLineageById: Record<string, WorktreeLineage>
  workspaceLineageByChildKey: Record<string, WorkspaceLineage>
} | null {
  const context = createLineageResolutionContext(store)
  const worktreeLineageById: Record<string, WorktreeLineage> = {}
  const workspaceLineageByChildKey: Record<string, WorkspaceLineage> = {}
  for (const [worktreeId, lineage] of Object.entries(store.getAllWorktreeLineage())) {
    const child = resolveWorktreeLineageOwner(context, worktreeId)
    const parent = resolveWorktreeLineageOwner(context, lineage.parentWorktreeId)
    if (child.status === 'ambiguous' || child.status === 'contradictory') {
      return null
    }
    if (parent.status === 'ambiguous' || parent.status === 'contradictory') {
      return null
    }
    if (child.status !== 'owned' || parent.status !== 'owned') {
      continue
    }
    if (
      child.hostId !== parent.hostId &&
      !isProjectScopedCrossHostEdge(
        store,
        { worktreeId, hostId: child.hostId },
        { worktreeId: lineage.parentWorktreeId, hostId: parent.hostId }
      )
    ) {
      return null
    }
    if (child.hostId === executionHostId) {
      worktreeLineageById[worktreeId] = structuredClone(lineage)
    }
  }
  for (const [childKey, lineage] of Object.entries(store.getAllWorkspaceLineage())) {
    const child = resolveWorkspaceLineageOwner(context, childKey)
    const parent = resolveWorkspaceLineageOwner(context, lineage.parentWorkspaceKey)
    if (child.status === 'ambiguous' || child.status === 'contradictory') {
      return null
    }
    if (parent.status === 'ambiguous' || parent.status === 'contradictory') {
      return null
    }
    if (child.status !== 'owned' || parent.status !== 'owned') {
      continue
    }
    if (
      child.hostId !== parent.hostId &&
      !isProjectScopedCrossHostEdge(
        store,
        { worktreeId: worktreeIdForWorkspaceKey(childKey), hostId: child.hostId },
        { worktreeId: worktreeIdForWorkspaceKey(lineage.parentWorkspaceKey), hostId: parent.hostId }
      )
    ) {
      return null
    }
    if (child.hostId === executionHostId) {
      workspaceLineageByChildKey[childKey] = structuredClone(lineage)
    }
  }
  return { worktreeLineageById, workspaceLineageByChildKey }
}
