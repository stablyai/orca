import type { Repo } from '../../../../shared/repo-types'
import { getProjectGroupSubtreeIds } from '../../../../shared/project-groups'
import { isPathInsideOrEqual } from '../../../../shared/cross-platform-path'
import { parseExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
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
  return connectionId
    ? [...grouped, ...pathRepos.filter((repo) => (repo.connectionId ?? null) === connectionId)]
    : grouped.length > 0
      ? [
          ...grouped,
          ...pathRepos.filter((repo) =>
            new Set(grouped.map((candidate) => candidate.connectionId ?? null)).has(
              repo.connectionId ?? null
            )
          )
        ]
      : pathRepos
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
    if (
      child.status === 'owned' &&
      parent.status === 'owned' &&
      child.hostId === executionHostId &&
      parent.hostId === executionHostId
    ) {
      worktreeLineageById[worktreeId] = structuredClone(lineage)
    } else if (
      child.status === 'owned' &&
      parent.status === 'owned' &&
      child.hostId !== parent.hostId
    ) {
      return null
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
    if (
      child.status === 'owned' &&
      parent.status === 'owned' &&
      child.hostId === executionHostId &&
      parent.hostId === executionHostId
    ) {
      workspaceLineageByChildKey[childKey] = structuredClone(lineage)
    } else if (
      child.status === 'owned' &&
      parent.status === 'owned' &&
      child.hostId !== parent.hostId
    ) {
      return null
    }
  }
  return { worktreeLineageById, workspaceLineageByChildKey }
}
