import type {
  HostTaskGitHubItemTarget,
  HostTaskGitLabItemTarget,
  HostTaskItemMutationTarget,
  HostTaskLinearTarget
} from './mobile-tasks-dependencies'
import type { TaskItem } from './mobile-tasks-project-workspace-types'

export {
  projectRowIdentityTarget,
  projectRowMutationTarget,
  projectRowSlugTarget
} from './mobile-tasks-project-row-targets'

export function taskItemMutationTarget(
  item: Extract<TaskItem, { provider: 'github' }>
): HostTaskGitHubItemTarget
export function taskItemMutationTarget(
  item: Extract<TaskItem, { provider: 'gitlab' }>
): HostTaskGitLabItemTarget
export function taskItemMutationTarget(
  item: Extract<TaskItem, { provider: 'github' | 'gitlab' }>
): HostTaskItemMutationTarget
export function taskItemMutationTarget(
  item: Extract<TaskItem, { provider: 'github' | 'gitlab' }>
): HostTaskItemMutationTarget {
  return item.provider === 'github'
    ? {
        provider: 'github',
        repoId: item.source.repoId,
        number: item.source.number,
        type: item.source.type,
        targetId: item.source.targetId
      }
    : {
        provider: 'gitlab',
        repoId: item.source.repoId,
        number: item.source.number,
        type: item.source.type,
        projectRef: item.source.projectRef,
        targetId: item.source.targetId
      }
}

export function taskLinearTarget(
  item: Extract<TaskItem, { provider: 'linear' }>
): HostTaskLinearTarget {
  return {
    issueId: item.source.id,
    workspaceId: item.source.workspaceId,
    teamId: item.source.team.id,
    projectId: item.source.project?.id,
    targetId: item.source.targetId
  }
}
