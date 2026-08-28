import type {
  ExternalTaskEditOptions,
  ExternalTaskProvider,
  ExternalTaskSelectOption
} from '../../shared/external-task-types'
import { listExternalTasks } from './client'
import { getNinjaOneEditOptions } from './ninja-client'

function uniqueOptions(values: (string | null | undefined)[]): ExternalTaskSelectOption[] {
  return [...new Set(values.filter((value): value is string => Boolean(value?.trim())))]
    .sort((left, right) => left.localeCompare(right))
    .map((value) => ({ value, label: value }))
}

export async function getExternalTaskEditOptions(
  provider: ExternalTaskProvider
): Promise<ExternalTaskEditOptions> {
  if (provider === 'ninjaone') {
    return getNinjaOneEditOptions()
  }
  if (provider === 'planner') {
    return {
      statuses: ['Open', 'In progress', 'Completed'].map((value) => ({ value, label: value })),
      assignees: [],
      priorities: [],
      severities: []
    }
  }
  const tasks = await listExternalTasks({ provider, limit: 100 })
  return {
    statuses: uniqueOptions(tasks.map((task) => task.status)),
    assignees: uniqueOptions(tasks.map((task) => task.assignee)),
    priorities: [],
    severities: []
  }
}
