import type { OrchestrationAgentView } from '../agent-view'

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

export type TaskReceiptResult = {
  task: { id: string; status: string }
  dispatchId?: string
  progressNote?: string
  progressUpdatedAt?: string
}

// The task row echoes the caller's spec back; the id, status, and optional passive note are what it acts on.
export const TASK_RECEIPT_VIEW: OrchestrationAgentView<
  TaskReceiptResult,
  {
    taskId: string
    status: string
    dispatchId?: string
    note?: string
    updatedAt?: string
  }
> = {
  fields: (value) => ({
    taskId: value.task.id,
    status: value.task.status,
    ...(value.dispatchId ? { dispatchId: value.dispatchId } : {}),
    ...(value.progressNote !== undefined ? { note: value.progressNote } : {}),
    ...(value.progressUpdatedAt ? { updatedAt: value.progressUpdatedAt } : {})
  })
}

export const TASK_LIST_VIEW: OrchestrationAgentView<TaskListResult, Record<string, unknown>> = {
  // Specs and results are free text that grows with the Run; --full keeps them.
  fields: (r) => ({
    tasks: r.tasks.map((task) => ({
      id: task.id,
      status: task.status,
      title: task.display_name ?? task.task_title ?? task.spec.slice(0, 60),
      deps: task.deps && task.deps !== '[]' ? task.deps : undefined,
      parentId: task.parent_id ?? undefined,
      dispatchId: task.dispatch_id ?? undefined,
      assignee: task.assignee_handle ?? undefined
    })),
    runId: r.runId,
    legacyReadOnly: r.legacyReadOnly || undefined
  })
}
