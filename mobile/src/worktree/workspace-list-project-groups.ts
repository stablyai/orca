import type { ProjectGroup } from '../../../src/shared/project-group-types'
import { getProjectGroupHeaderKey } from '../../../src/shared/project-groups'
import type { Section } from './workspace-list-types'

function repoIdFromSectionKey(key: string): string {
  return key.startsWith('repo:') ? key.slice('repo:'.length) : key
}

function sortProjectGroups(groups: readonly ProjectGroup[]): ProjectGroup[] {
  return [...groups].sort(
    (left, right) => left.tabOrder - right.tabOrder || left.name.localeCompare(right.name)
  )
}

export function nestRepoSectionsInProjectGroups(args: {
  repoSections: readonly Section[]
  projectGroups: readonly ProjectGroup[]
  repoProjectGroupIdByRepoId: ReadonlyMap<string, string | null>
}): Section[] {
  const { repoSections, projectGroups, repoProjectGroupIdByRepoId } = args
  if (projectGroups.length === 0) {
    return repoSections.map((section) => ({ ...section, kind: 'repo' as const, depth: 0 }))
  }

  const groupsById = new Map(projectGroups.map((group) => [group.id, group]))
  const sectionsByGroupId = new Map<string | null, Section[]>()
  for (const section of repoSections) {
    const repoId = repoIdFromSectionKey(section.key)
    const membership = repoProjectGroupIdByRepoId.get(repoId) ?? null
    const groupId = membership && groupsById.has(membership) ? membership : null
    const list = sectionsByGroupId.get(groupId) ?? []
    list.push(section)
    sectionsByGroupId.set(groupId, list)
  }

  const childrenByParentId = new Map<string | null, ProjectGroup[]>()
  for (const group of projectGroups) {
    const parentId =
      group.parentGroupId && groupsById.has(group.parentGroupId) ? group.parentGroupId : null
    const children = childrenByParentId.get(parentId) ?? []
    children.push(group)
    childrenByParentId.set(parentId, children)
  }
  for (const children of childrenByParentId.values()) {
    children.sort(
      (left, right) => left.tabOrder - right.tabOrder || left.name.localeCompare(right.name)
    )
  }

  const getSubtreeCount = (groupId: string): number => {
    const direct = sectionsByGroupId.get(groupId)?.length ?? 0
    const children = childrenByParentId.get(groupId) ?? []
    return children.reduce((count, child) => count + getSubtreeCount(child.id), direct)
  }

  const result: Section[] = []
  const appendProjectGroup = (projectGroup: ProjectGroup, depth: number): void => {
    const key = getProjectGroupHeaderKey(projectGroup.id)
    result.push({
      key,
      title: projectGroup.name,
      kind: 'project-group',
      depth,
      icon: 'folder',
      count: getSubtreeCount(projectGroup.id),
      data: []
    })
    for (const section of sectionsByGroupId.get(projectGroup.id) ?? []) {
      result.push({ ...section, kind: 'repo', depth: depth + 1 })
    }
    for (const child of childrenByParentId.get(projectGroup.id) ?? []) {
      appendProjectGroup(child, depth + 1)
    }
    sectionsByGroupId.delete(projectGroup.id)
  }

  for (const root of sortProjectGroups(childrenByParentId.get(null) ?? [])) {
    appendProjectGroup(root, 0)
  }

  const remaining = [...(sectionsByGroupId.get(null) ?? [])]
  for (const [groupId, sections] of sectionsByGroupId) {
    if (groupId === null || groupsById.has(groupId)) {
      continue
    }
    remaining.push(...sections)
  }
  for (const section of remaining) {
    result.push({ ...section, kind: 'repo', depth: 0 })
  }
  return result
}
