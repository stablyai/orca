import { resolve } from 'node:path'
import type { Store } from '../persistence'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import {
  buildProjectGroupOwnerIndex,
  getProjectGroupOwnerHostId,
  resolveFolderWorkspaceProjectGroup
} from '../../shared/project-groups'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId
} from '../../shared/execution-host'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../shared/project-group-types'
import type { Repo } from '../../shared/repo-types'
import {
  resolveFolderWorkspaceCatalogOwnerHostIdFromIndex,
  resolveFolderWorkspaceProjectGroupWithLegacySsh
} from '../../shared/folder-workspaces'
import {
  emptyGroupMembershipSummary,
  isRemoteOnlyFolderScopeWithIndex,
  ownerGroupKey,
  type GroupMembershipSummary
} from './filesystem-folder-scope-classification'

type FolderScopeStore = Pick<Store, 'getRepos'> &
  Partial<Pick<Store, 'getProjectGroups' | 'getFolderWorkspaces'>>

export function getLocalRepos(store: Store): Repo[] {
  return store
    .getRepos()
    .filter(
      (repo) => !repo.connectionId && getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID
    )
}

type FolderAuthIndex = {
  projectGroupIndex: ReturnType<typeof buildProjectGroupOwnerIndex>
  groupMembership: ReadonlyMap<string, GroupMembershipSummary>
  legacyGroupMembership: ReadonlyMap<string, GroupMembershipSummary>
  allRepoPaths: readonly string[]
  localOwnerRepoPaths: readonly string[]
  unconnectedRepoPathsByOwner: ReadonlyMap<string, readonly string[]>
}

function mergeGroupMembership(target: GroupMembershipSummary, child: GroupMembershipSummary): void {
  target.repoCount += child.repoCount
  target.folderWorkspaceCount += child.folderWorkspaceCount
  target.hasLocalOwner ||= child.hasLocalOwner
  target.hasLocalFolderWorkspace ||= child.hasLocalFolderWorkspace
  target.hasUnconnectedRepo ||= child.hasUnconnectedRepo
  target.unsafeCycle ||= child.unsafeCycle
}

function buildFolderAuthIndex(
  projectGroups: readonly ProjectGroup[],
  repos: readonly Repo[],
  folderWorkspaces: readonly FolderWorkspace[]
): FolderAuthIndex {
  const projectGroupIndex = buildProjectGroupOwnerIndex(projectGroups)
  const parentByGroup = new Map<string, string>()
  const remainingChildren = new Map<string, number>()
  const groupMembership = new Map<string, GroupMembershipSummary>()
  const legacyParentsByGroup = new Map<string, Set<string>>()
  const legacyChildrenByGroup = new Map<string, Set<string>>()
  const legacyGroupMembership = new Map<string, GroupMembershipSummary>()
  for (const group of projectGroups) {
    const ownerHostId = getProjectGroupOwnerHostId(group)
    const key = ownerGroupKey(ownerHostId, group.id)
    remainingChildren.set(key, 0)
    groupMembership.set(key, emptyGroupMembershipSummary())
    legacyGroupMembership.set(
      group.id,
      legacyGroupMembership.get(group.id) ?? emptyGroupMembershipSummary()
    )
    if (group.parentGroupId) {
      const parents = legacyParentsByGroup.get(group.id) ?? new Set<string>()
      parents.add(group.parentGroupId)
      legacyParentsByGroup.set(group.id, parents)
      const children = legacyChildrenByGroup.get(group.parentGroupId) ?? new Set<string>()
      children.add(group.id)
      legacyChildrenByGroup.set(group.parentGroupId, children)
    }
  }
  for (const group of projectGroups) {
    if (!group.parentGroupId) {
      continue
    }
    const ownerHostId = getProjectGroupOwnerHostId(group)
    const key = ownerGroupKey(ownerHostId, group.id)
    const parentKey = ownerGroupKey(ownerHostId, group.parentGroupId)
    if (remainingChildren.has(parentKey)) {
      parentByGroup.set(key, parentKey)
      remainingChildren.set(parentKey, (remainingChildren.get(parentKey) ?? 0) + 1)
    }
  }

  const allRepoPaths: string[] = []
  const localOwnerRepoPaths: string[] = []
  const unconnectedRepoPathsByOwner = new Map<string, string[]>()
  for (const repo of repos) {
    const ownerHostId = getRepoExecutionHostId(repo)
    const normalizedPath = normalizeRuntimePathForComparison(repo.path)
    allRepoPaths.push(normalizedPath)
    if (ownerHostId === LOCAL_EXECUTION_HOST_ID) {
      localOwnerRepoPaths.push(normalizedPath)
    }
    if (!repo.connectionId) {
      const ownerPaths = unconnectedRepoPathsByOwner.get(ownerHostId) ?? []
      ownerPaths.push(normalizedPath)
      unconnectedRepoPathsByOwner.set(ownerHostId, ownerPaths)
    }
    if (typeof repo.projectGroupId !== 'string') {
      continue
    }
    const summary = groupMembership.get(ownerGroupKey(ownerHostId, repo.projectGroupId))
    if (summary) {
      summary.repoCount++
      summary.hasLocalOwner ||= ownerHostId === LOCAL_EXECUTION_HOST_ID
      summary.hasUnconnectedRepo ||= !repo.connectionId
    }
    const legacySummary = legacyGroupMembership.get(repo.projectGroupId)
    if (legacySummary) {
      legacySummary.repoCount++
      legacySummary.hasLocalOwner ||= ownerHostId === LOCAL_EXECUTION_HOST_ID
      legacySummary.hasUnconnectedRepo ||= !repo.connectionId
    }
  }

  for (const workspace of folderWorkspaces) {
    const group = resolveFolderWorkspaceProjectGroupWithLegacySsh(projectGroupIndex, workspace)
    if (!group) {
      continue
    }
    if (
      workspace.connectionId === undefined &&
      !normalizeExecutionHostId(workspace.executionHostId) &&
      group.connectionId === undefined &&
      !normalizeExecutionHostId(group.executionHostId)
    ) {
      continue
    }
    const ownerHostId = resolveFolderWorkspaceCatalogOwnerHostIdFromIndex(
      workspace,
      projectGroupIndex
    )
    const summary = groupMembership.get(ownerGroupKey(getProjectGroupOwnerHostId(group), group.id))
    if (summary) {
      summary.folderWorkspaceCount++
      summary.hasLocalFolderWorkspace ||= ownerHostId === LOCAL_EXECUTION_HOST_ID
    }
    const legacySummary = legacyGroupMembership.get(group.id)
    if (legacySummary) {
      legacySummary.folderWorkspaceCount++
      legacySummary.hasLocalFolderWorkspace ||= ownerHostId === LOCAL_EXECUTION_HOST_ID
    }
  }

  const pending = [...remainingChildren]
    .filter(([, childCount]) => childCount === 0)
    .map(([key]) => key)
  let processed = 0
  while (pending.length > 0) {
    const key = pending.pop()!
    processed++
    const parentKey = parentByGroup.get(key)
    if (!parentKey) {
      continue
    }
    mergeGroupMembership(groupMembership.get(parentKey)!, groupMembership.get(key)!)
    const nextChildCount = (remainingChildren.get(parentKey) ?? 1) - 1
    remainingChildren.set(parentKey, nextChildCount)
    if (nextChildCount === 0) {
      pending.push(parentKey)
    }
  }
  if (processed !== groupMembership.size) {
    for (const [key, childCount] of remainingChildren) {
      if (childCount > 0) {
        groupMembership.get(key)!.unsafeCycle = true
      }
    }
  }

  const legacyRemainingChildren = new Map(
    [...legacyGroupMembership.keys()].map((groupId) => [
      groupId,
      legacyChildrenByGroup.get(groupId)?.size ?? 0
    ])
  )
  const legacyPending = [...legacyRemainingChildren]
    .filter(([, childCount]) => childCount === 0)
    .map(([groupId]) => groupId)
  let legacyProcessed = 0
  while (legacyPending.length > 0) {
    const groupId = legacyPending.pop()!
    legacyProcessed++
    for (const parentId of legacyParentsByGroup.get(groupId) ?? []) {
      const parentSummary = legacyGroupMembership.get(parentId)
      if (!parentSummary) {
        continue
      }
      mergeGroupMembership(parentSummary, legacyGroupMembership.get(groupId)!)
      const nextChildCount = (legacyRemainingChildren.get(parentId) ?? 1) - 1
      legacyRemainingChildren.set(parentId, nextChildCount)
      if (nextChildCount === 0) {
        legacyPending.push(parentId)
      }
    }
  }
  if (legacyProcessed !== legacyGroupMembership.size) {
    for (const [groupId, childCount] of legacyRemainingChildren) {
      if (childCount > 0) {
        legacyGroupMembership.get(groupId)!.unsafeCycle = true
      }
    }
  }

  allRepoPaths.sort()
  localOwnerRepoPaths.sort()
  for (const paths of unconnectedRepoPathsByOwner.values()) {
    paths.sort()
  }
  return {
    projectGroupIndex,
    groupMembership,
    legacyGroupMembership,
    allRepoPaths,
    localOwnerRepoPaths,
    unconnectedRepoPathsByOwner
  }
}

export function getLocalFolderScopeRoots(store: Store): string[] {
  const scopeStore = store as FolderScopeStore
  const repos = scopeStore.getRepos()
  const projectGroups = scopeStore.getProjectGroups?.() ?? []
  const folderWorkspaces = scopeStore.getFolderWorkspaces?.() ?? []
  const index = buildFolderAuthIndex(projectGroups, repos, folderWorkspaces)
  const roots: string[] = []
  for (const group of projectGroups) {
    if (
      group.parentPath &&
      !isRemoteOnlyFolderScopeWithIndex(
        index,
        group.parentPath,
        group.id,
        getProjectGroupOwnerHostId(group),
        group.connectionId === undefined &&
          group.executionHostId === undefined &&
          index.projectGroupIndex.byId.get(group.id)?.length === 1
      )
    ) {
      roots.push(resolve(group.parentPath))
    }
  }
  for (const workspace of folderWorkspaces) {
    const group = resolveFolderWorkspaceProjectGroup(index.projectGroupIndex, workspace)
    if (!group && index.projectGroupIndex.byId.has(workspace.projectGroupId)) {
      continue
    }
    const ownerHostId = group
      ? getProjectGroupOwnerHostId(group)
      : resolveFolderWorkspaceCatalogOwnerHostIdFromIndex(workspace, index.projectGroupIndex)
    if (
      ownerHostId &&
      !isRemoteOnlyFolderScopeWithIndex(
        index,
        workspace.folderPath,
        workspace.projectGroupId,
        ownerHostId,
        workspace.connectionId === undefined &&
          workspace.executionHostId === undefined &&
          index.projectGroupIndex.byId.get(workspace.projectGroupId)?.length === 1
      )
    ) {
      roots.push(resolve(workspace.folderPath))
    }
  }
  return roots
}
