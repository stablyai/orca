import type { OrchestrationAgentView } from './agent-view'

export type TaskListResult = {
  tasks: {
    id: string
    spec: string
    task_title?: string | null
    display_name?: string | null
    status: string
    assignee_handle?: string | null
    dispatch_id?: string | null
    spec_truncated?: boolean
    deps?: string
    parent_id?: string | null
    result?: string | null
  }[]
  count: number
  runId?: string
  legacyReadOnly?: boolean
}

// The task row echoes the caller's spec back; the id and status are what it acts on.
export const TASK_RECEIPT_VIEW: OrchestrationAgentView<
  { task: { id: string; status: string } },
  { taskId: string; status: string }
> = {
  fields: (value) => ({ taskId: value.task.id, status: value.task.status })
}

export const TASK_LIST_VIEW: OrchestrationAgentView<TaskListResult, Record<string, unknown>> = {
  // Rows also carry creator identity and timestamps that no next command takes.
  fields: (r) => ({
    tasks: r.tasks.map((task) => ({
      id: task.id,
      status: task.status,
      title: task.display_name ?? task.task_title ?? undefined,
      spec: task.spec,
      specTruncated: task.spec_truncated || undefined,
      deps: task.deps && task.deps !== '[]' ? task.deps : undefined,
      parentId: task.parent_id ?? undefined,
      result: task.result ?? undefined,
      dispatchId: task.dispatch_id ?? undefined,
      assignee: task.assignee_handle ?? undefined
    })),
    runId: r.runId,
    legacyReadOnly: r.legacyReadOnly || undefined
  })
}
