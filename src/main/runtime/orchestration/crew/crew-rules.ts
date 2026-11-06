import { buildOrchestrationTaskDisplayMetadata } from '../../../../shared/orchestration-task-display'
import type { TaskRow } from '../types'

export function crewTaskDisplay(
  task: Pick<TaskRow, 'spec' | 'task_title' | 'display_name'> | undefined
) {
  return typeof task?.spec === 'string'
    ? buildOrchestrationTaskDisplayMetadata({
        spec: task.spec,
        taskTitle: task.task_title,
        displayName: task.display_name
      })
    : { taskTitle: '', displayName: '' }
}

export function creatorFirstParent<T>(
  creator: T | undefined,
  coordinator: T | undefined,
  coordinatorIsSelf: boolean
): T | undefined {
  return creator ?? (coordinatorIsSelf ? undefined : coordinator)
}

export function crewDisplayName(...names: (string | null | undefined)[]): string | null {
  return names.find((name) => Boolean(name)) || null
}
