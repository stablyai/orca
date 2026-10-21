import { isSettledBackgroundTaskState } from '../../shared/native-chat-background-task-row'
import {
  classifyClaudeBackgroundTaskKind,
  record,
  taskDescription,
  taskId,
  taskName
} from './claude-background-task-frames'
import type {
  ClaudeBackgroundTaskChange,
  ClaudeBackgroundTaskRow
} from './claude-background-task-row-lifecycle'

/** A roster carries membership and identity, not a task's terminal outcome. */
export function observeClaudeBackgroundTaskRoster(
  tasks: unknown[],
  rows: Map<string, ClaudeBackgroundTaskRow>,
  revise: (id: string, change: ClaudeBackgroundTaskChange) => void
): void {
  for (const entry of tasks) {
    const task = record(entry)
    const id = task === null ? null : taskId(task)
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
    // Presence must not revive a settled row; the task's own frames alone
    // settle or restart it, while the roster enriches its identity fields.
    revise(id, {
      label: taskDescription(task.description) ?? taskName(task),
      kind:
        task.task_type === undefined ? undefined : classifyClaudeBackgroundTaskKind(task.task_type)
    })
  }
}
