import { isSettledBackgroundTaskState } from '../../shared/native-chat/input/native-chat-background-task-row'
import {
  classifyClaudeBackgroundTaskKind,
  record,
  taskDescription,
  taskId,
  taskName,
  taskAliasId
} from './claude-background-task-frames'
import type {
  ClaudeBackgroundTaskChange,
  ClaudeBackgroundTaskRow
} from './claude-background-task-row-lifecycle'

/** A roster carries membership and identity, not a task's terminal outcome. */
export function observeClaudeBackgroundTaskRoster(
  tasks: unknown[],
  rows: Map<string, ClaudeBackgroundTaskRow>,
  revise: (id: string, change: ClaudeBackgroundTaskChange) => void,
  admitOwned?: (id: string, task: Record<string, unknown>) => void
): void {
  for (const entry of tasks) {
    const task = record(entry)
    const id = task === null ? null : taskId(task)
    if (
      task &&
      id &&
      taskAliasId(task.parent_task_id) &&
      task.ambient !== true &&
      task.skip_transcript !== true
    ) {
      admitOwned?.(id, task)
    }
    const row = id === null ? undefined : rows.get(id)
    if (
      task === null ||
      id === null ||
      task.ambient === true ||
      !row ||
      isSettledBackgroundTaskState(row.block.state)
    ) {
      continue
    }
    revise(id, {
      label: taskDescription(task.description) ?? taskName(task),
      kind:
        task.task_type === undefined ? undefined : classifyClaudeBackgroundTaskKind(task.task_type)
    })
  }
}
