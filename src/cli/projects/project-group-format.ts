import type { ProjectGroup } from '../../shared/project/groups/project-group-types'

function formatGroupLine(group: ProjectGroup): string {
  return group.parentGroupId
    ? `${group.id}  ${group.name}  parent:${group.parentGroupId}`
    : `${group.id}  ${group.name}`
}

export function formatProjectGroupList(result: { groups: ProjectGroup[] }): string {
  if (result.groups.length === 0) {
    return 'No project groups found.'
  }
  return result.groups.map(formatGroupLine).join('\n')
}

export function formatProjectGroupShow(result: { group: ProjectGroup }): string {
  return formatGroupLine(result.group)
}
