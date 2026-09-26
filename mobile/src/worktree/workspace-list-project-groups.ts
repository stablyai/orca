import { projectGroupIdFromRepoId } from '../../../src/shared/folder-workspace-worktree'
import {
  getEffectiveProjectGroupManualRank,
  UNGROUPED_PROJECT_GROUP_KEY
} from '../../../src/shared/project-groups'
import { applyMobileWorkspaceLineage } from './mobile-workspace-lineage'
import type { FilterState, Section, Worktree } from './workspace-list-types'
import { getWorktreeRowIdentity } from './worktree-host-row-identity'

export type MobileProjectGroup = {
  id: string
  name: string
  parentGroupId: string | null
  tabOrder: number
}

export type MobileRepoGrouping = {
  projectGroupId: string | null
  projectGroupOrder?: number
}

export type MobileRepoCatalogGrouping = {
  id: string
  projectGroupId?: string | null
  projectGroupOrder?: number
}

type RepoBucket = {
  displayName: string
  repoId: string
  items: Worktree[]
}

/** Desktop sidebar collapse key for a project group (`getProjectGroupHeaderKey`). */
export function getMobileProjectGroupSectionKey(groupId: string | null): string {
  return groupId ? `project-group:${groupId}` : UNGROUPED_PROJECT_GROUP_KEY
}

export function buildRepoGroupingById(
  repos: readonly MobileRepoCatalogGrouping[]
): Map<string, MobileRepoGrouping> {
  return new Map(
    repos.map((repo) => [
      repo.id,
      {
        projectGroupId: repo.projectGroupId ?? null,
        ...(typeof repo.projectGroupOrder === 'number'
          ? { projectGroupOrder: repo.projectGroupOrder }
          : {})
      }
    ])
  )
}

export function buildMobileProjectGroupSections(args: {
  worktrees: Worktree[]
  canonicalGroupWorktrees: Worktree[]
  filters: FilterState
  search: string
  repoIdsByName: ReadonlyMap<string, string>
  collapsedGroups: ReadonlySet<string>
  projectGroups: readonly MobileProjectGroup[]
  repoGroupingById: ReadonlyMap<string, MobileRepoGrouping>
}): Section[] {
  const {
    worktrees,
    canonicalGroupWorktrees,
    filters,
    search,
    repoIdsByName,
    collapsedGroups,
    projectGroups,
    repoGroupingById
  } = args
  const knownGroupIds = new Set(projectGroups.map((group) => group.id))
  const bucketsByGroupId = new Map<string | null, RepoBucket[]>()
  const folderWorktreesByGroupId = new Map<string | null, Worktree[]>()
  for (const worktree of canonicalGroupWorktrees) {
    if (!isMobileFolderWorkspace(worktree)) {
      continue
    }
    const groupId = resolveProjectGroupId(worktree.repoId, repoGroupingById, knownGroupIds)
    const list = folderWorktreesByGroupId.get(groupId) ?? []
    list.push(worktree)
    folderWorktreesByGroupId.set(groupId, list)
  }
  for (const bucket of collectRepoBucketsById(
    worktrees,
    canonicalGroupWorktrees,
    repoIdsByName,
    filters,
    search
  )) {
    const groupId = resolveProjectGroupId(bucket.repoId, repoGroupingById, knownGroupIds)
    const list = bucketsByGroupId.get(groupId) ?? []
    list.push(bucket)
    bucketsByGroupId.set(groupId, list)
  }
  for (const buckets of bucketsByGroupId.values()) {
    sortBucketsInGroup(buckets, repoGroupingById)
  }

  const projectGroupsById = new Map(projectGroups.map((group) => [group.id, group]))
  const childGroupsByParentId = new Map<string | null, MobileProjectGroup[]>()
  for (const group of projectGroups) {
    const parentId =
      group.parentGroupId && projectGroupsById.has(group.parentGroupId) ? group.parentGroupId : null
    const children = childGroupsByParentId.get(parentId) ?? []
    children.push(group)
    childGroupsByParentId.set(parentId, children)
  }
  for (const groups of childGroupsByParentId.values()) {
    groups.sort(
      (left, right) => left.tabOrder - right.tabOrder || left.name.localeCompare(right.name)
    )
  }

  const subtreeRepoCount = (groupId: string): number => {
    const direct =
      (bucketsByGroupId.get(groupId) ?? []).length +
      (folderWorktreesByGroupId.get(groupId) ?? []).length
    return (childGroupsByParentId.get(groupId) ?? []).reduce(
      (count, child) => count + subtreeRepoCount(child.id),
      direct
    )
  }

  const sections: Section[] = []
  const visited = new Set<string>()
  const appendGroup = (group: MobileProjectGroup, depth: number): void => {
    if (visited.has(group.id)) {
      return
    }
    visited.add(group.id)
    const key = getMobileProjectGroupSectionKey(group.id)
    sections.push({
      key,
      title: group.name,
      icon: 'folder',
      data: mapSectionData(key, folderWorktreesByGroupId.get(group.id) ?? [], collapsedGroups),
      depth,
      count: subtreeRepoCount(group.id)
    })
    if (collapsedGroups.has(key)) {
      return
    }
    for (const bucket of bucketsByGroupId.get(group.id) ?? []) {
      sections.push(makeRepoSection(bucket, depth + 1, collapsedGroups))
    }
    for (const child of childGroupsByParentId.get(group.id) ?? []) {
      appendGroup(child, depth + 1)
    }
  }

  for (const group of childGroupsByParentId.get(null) ?? []) {
    appendGroup(group, 0)
  }

  const ungrouped = bucketsByGroupId.get(null) ?? []
  const ungroupedFolders = folderWorktreesByGroupId.get(null) ?? []
  if (ungrouped.length > 0 || ungroupedFolders.length > 0) {
    const key = getMobileProjectGroupSectionKey(null)
    sections.push({
      key,
      title: 'Ungrouped',
      icon: 'folder',
      data: mapSectionData(key, ungroupedFolders, collapsedGroups),
      depth: 0,
      count: ungrouped.length + ungroupedFolders.length
    })
    if (!collapsedGroups.has(key)) {
      for (const bucket of ungrouped) {
        sections.push(makeRepoSection(bucket, 1, collapsedGroups))
      }
    }
  }
  return sections
}

function isMobileFolderWorkspace(worktree: Worktree): boolean {
  return (
    worktree.workspaceKind === 'folder-workspace' ||
    projectGroupIdFromRepoId(worktree.repoId) !== null
  )
}

function resolveProjectGroupId(
  repoId: string,
  repoGroupingById: ReadonlyMap<string, MobileRepoGrouping>,
  knownGroupIds: ReadonlySet<string>
): string | null {
  const groupId =
    repoGroupingById.get(repoId)?.projectGroupId ?? projectGroupIdFromRepoId(repoId) ?? null
  return groupId && knownGroupIds.has(groupId) ? groupId : null
}

function collectRepoBucketsById(
  worktrees: Worktree[],
  canonicalGroupWorktrees: Worktree[],
  repoIdsByName: ReadonlyMap<string, string>,
  filters: FilterState,
  search: string
): RepoBucket[] {
  const byRepoId = new Map<string, RepoBucket>()
  for (const worktree of canonicalGroupWorktrees) {
    if (isMobileFolderWorkspace(worktree)) {
      continue
    }
    const existing = byRepoId.get(worktree.repoId)
    if (existing) {
      existing.items.push(worktree)
    } else {
      byRepoId.set(worktree.repoId, {
        displayName: worktree.repo || 'Unknown',
        repoId: worktree.repoId,
        items: [worktree]
      })
    }
  }
  const representedRepoIds = new Set(worktrees.map((worktree) => worktree.repoId))
  const query = search.trim().toLowerCase()
  for (const [displayName, repoId] of repoIdsByName) {
    if (representedRepoIds.has(repoId) || byRepoId.has(repoId)) {
      continue
    }
    if (filters.filterRepoIds.size > 0 && !filters.filterRepoIds.has(repoId)) {
      continue
    }
    if (query && !displayName.toLowerCase().includes(query)) {
      continue
    }
    byRepoId.set(repoId, { displayName, repoId, items: [] })
  }
  return [...byRepoId.values()]
}

function sortBucketsInGroup(
  buckets: RepoBucket[],
  repoGroupingById: ReadonlyMap<string, MobileRepoGrouping>
): void {
  buckets.sort((left, right) => {
    const leftRank = getEffectiveProjectGroupManualRank({
      id: left.repoId,
      projectGroupOrder: repoGroupingById.get(left.repoId)?.projectGroupOrder
    })
    const rightRank = getEffectiveProjectGroupManualRank({
      id: right.repoId,
      projectGroupOrder: repoGroupingById.get(right.repoId)?.projectGroupOrder
    })
    // Infinity - Infinity is NaN and would skip the displayName fallback.
    if (leftRank !== rightRank) {
      return leftRank < rightRank ? -1 : 1
    }
    return left.displayName.localeCompare(right.displayName)
  })
}

function orderMainWorktreeFirst(worktrees: Worktree[]): Worktree[] {
  const mainWorktrees = worktrees.filter((worktree) => worktree.isMainWorktree)
  if (mainWorktrees.length === 0) {
    return worktrees
  }
  return [...mainWorktrees, ...worktrees.filter((worktree) => !worktree.isMainWorktree)]
}

function mapSectionData(
  key: string,
  items: Worktree[],
  collapsedGroups: ReadonlySet<string>
): Worktree[] {
  return applyMobileWorkspaceLineage(items, collapsedGroups).map((worktree) => ({
    ...worktree,
    sectionListKey: `${key}:${getWorktreeRowIdentity(worktree)}`
  }))
}

function makeRepoSection(
  bucket: RepoBucket,
  depth: number,
  collapsedGroups: ReadonlySet<string>
): Section {
  const key = `repo:${bucket.repoId}`
  return {
    key,
    title: bucket.displayName,
    data: mapSectionData(key, orderMainWorktreeFirst(bucket.items), collapsedGroups),
    depth
  }
}
