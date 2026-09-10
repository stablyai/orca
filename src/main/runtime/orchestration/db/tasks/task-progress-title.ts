import { buildOrchestrationTaskDisplayMetadata } from '../../../../../shared/orchestration-task-display'
import type { TaskRow } from '../../types'

export function disambiguateTaskProgressTitles(
  tasks: readonly TaskRow[],
  bound: (value: string, fallback: string) => string
): string[] {
  const candidates = tasks.map((task) => taskTitleCandidate(task, bound))
  const totals = new Map<string, number>()
  for (const candidate of candidates) {
    totals.set(candidate, (totals.get(candidate) ?? 0) + 1)
  }
  const ordinals = new Map<string, number>()
  return candidates.map((candidate) => {
    const ordinal = (ordinals.get(candidate) ?? 0) + 1
    ordinals.set(candidate, ordinal)
    return candidate !== 'Untitled task' && totals.get(candidate) === 1
      ? candidate
      : bound(`${candidate} ${ordinal}`, 'Untitled task')
  })
}

function taskTitleCandidate(
  task: TaskRow,
  bound: (value: string, fallback: string) => string
): string {
  if (task.task_title?.trim()) {
    return bound(task.task_title, 'Untitled task')
  }
  if (task.display_name?.trim()) {
    return bound(task.display_name, 'Untitled task')
  }
  return buildOrchestrationTaskDisplayMetadata({ spec: task.spec }).taskTitle || 'Untitled task'
}
