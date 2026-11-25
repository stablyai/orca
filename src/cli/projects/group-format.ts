import type { ProjectGroup } from '../../shared/project/groups/project-group-types'

/** Top-level groups rank by rootProjectOrder once the sidebar has one; otherwise by tabOrder. */
export function groupSiblingOrder(group: ProjectGroup): number {
  return !group.parentGroupId && group.rootProjectOrder !== undefined
    ? group.rootProjectOrder
    : group.tabOrder
}

export function formatGroupList(result: { groups: ProjectGroup[] }): string {
  if (result.groups.length === 0) {
    return 'No project groups found.'
  }
  const nameById = new Map(result.groups.map((group) => [group.id, group.name]))
  return result.groups
    .map((group) =>
      [
        group.id,
        group.name,
        `parent:${group.parentGroupId ? (nameById.get(group.parentGroupId) ?? group.parentGroupId) : 'none'}`,
        `order:${groupSiblingOrder(group)}`,
        `color:${group.color ?? 'none'}`
      ].join('  ')
    )
    .join('\n')
}

export function formatGroupShow(result: { group: ProjectGroup }): string {
  const { group } = result
  return [
    `id: ${group.id}`,
    `name: ${group.name}`,
    `parent: ${group.parentGroupId ?? 'none'}`,
    `order: ${groupSiblingOrder(group)}`,
    `color: ${group.color ?? 'none'}`
  ].join('\n')
}

export type GroupRemoval = {
  deleted: boolean
  group: { id: string; name: string }
  ungroupedProjects: number
  removedChildGroups: number
  removedFolderWorkspaces: number
}

export function formatGroupRemoval(result: GroupRemoval): string {
  if (!result.deleted) {
    return `Project group ${result.group.name} was already gone.`
  }
  return [
    `Removed project group ${result.group.name} (${result.group.id}).`,
    `projects moved out of the group: ${result.ungroupedProjects}`,
    `nested groups removed: ${result.removedChildGroups}`,
    `folder workspaces removed: ${result.removedFolderWorkspaces}`
  ].join('\n')
}
