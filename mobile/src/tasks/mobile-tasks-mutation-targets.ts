import type {
  HostTaskGitHubItemTarget,
  HostTaskGitLabItemTarget,
  HostTaskItemMutationTarget
} from './host-task-item-mutation-operations'
import type { HostTaskLinearTarget } from './host-task-linear-operations'
import type { TaskItem } from './mobile-tasks-project-workspace-types'

export {
  projectRowIdentityTarget,
  projectRowMutationTarget,
  projectRowPullRequestTarget,
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
        type: item.source.type
      }
    : {
        provider: 'gitlab',
        repoId: item.source.repoId,
        number: item.source.number,
        type: item.source.type,
        projectRef: item.source.projectRef
      }
}

export function taskLinearTarget(
  item: Extract<TaskItem, { provider: 'linear' }>
): HostTaskLinearTarget {
  return {
    issueId: item.source.id,
    workspaceId: item.source.workspaceId,
    teamId: item.source.team.id,
    projectId: item.source.project?.id
  }
}
