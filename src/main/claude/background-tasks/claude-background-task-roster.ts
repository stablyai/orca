import type { ClaudeTaskInvocations } from './claude-task-invocations'
import { isSettledBackgroundTaskState } from '../../../shared/native-chat/input/task-lists/native-chat-background-task-row'
import { classifyClaudeBackgroundTaskKind } from '../../../shared/claude-background-task-kind'
import { record, taskDescription, taskId, taskName } from './claude-background-task-frames'
import type {
  ClaudeBackgroundTaskChange,
  ClaudeBackgroundTaskRow
} from './claude-background-task-row-lifecycle'

/** A roster carries membership and identity, not a task's terminal outcome. */
export function observeClaudeBackgroundTaskRoster(
  tasks: unknown[],
  rows: Map<string, ClaudeBackgroundTaskRow>,
  revise: (id: string, change: ClaudeBackgroundTaskChange) => void,
  admitOwned?: (id: string, task: Record<string, unknown>) => boolean | void
): void {
  for (const entry of tasks) {
    const task = record(entry)
    const id = task === null ? null : taskId(task)
    if (task && id && task.ambient !== true && task.skip_transcript !== true) {
      if (admitOwned?.(id, task) === false) {
        continue
      }
    }
    const row = id === null ? undefined : rows.get(id)
    if (
      task === null ||
      id === null ||
      task.ambient === true ||
      task.skip_transcript === true ||
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

export function observeOwnedClaudeBackgroundTaskRoster(input: {
  tasks: unknown[]
  rows: Map<string, ClaudeBackgroundTaskRow>
  invocations: ClaudeTaskInvocations
  revise: (id: string, change: ClaudeBackgroundTaskChange) => void
  attribute: (id: string, row: ClaudeBackgroundTaskRow) => void
  admit: (id: string, task: Record<string, unknown>) => void
}): void {
  observeClaudeBackgroundTaskRoster(input.tasks, input.rows, input.revise, (id, task) => {
    const selected = input.invocations.selection(task, id)
    if (!selected?.acceptsStart || selected.invocation.excluded || selected.invocation.monitor) {
      return false
    }
    const row = input.rows.get(id)
    if (row) {
      input.attribute(id, row)
    } else if (selected.invocation.parentTaskId !== undefined) {
      input.admit(id, task)
    }
    return true
  })
}
