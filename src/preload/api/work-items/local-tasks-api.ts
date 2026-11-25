import type { LocalTaskListResult } from '../../../shared/local-tasks/local-task-types'

export type LocalTasksApi = {
  list: () => Promise<LocalTaskListResult>
}
