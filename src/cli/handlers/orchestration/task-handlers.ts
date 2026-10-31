import type { CommandHandler } from '../../dispatch'
import { printOrchestrationResult } from './agent-view'
import { getOptionalStringFlag, getRequiredStringFlag } from '../../flags'
import { RuntimeClientError } from '../../runtime-client'
import { abbreviateOrchestrationTasks } from '../../../shared/orchestration-task-summary'
import { callOrchestrationMutation } from './mutation-request'
import { resolveCoordinatorTerminalHandle, runScopedSessionCaller } from './terminal-identity'

const TASK_STATUS_VALUES = [
  'pending',
  'ready',
  'dispatched',
  'completed',
  'failed',
  'blocked'
] as const

export const ORCHESTRATION_TASK_HANDLERS: Record<string, CommandHandler> = {
  'orchestration task-create': async ({ flags, client, cwd, json }) => {
    const callerTerminalHandle = await resolveCoordinatorTerminalHandle(flags, cwd, client)
    const result = await callOrchestrationMutation<{ task: { id: string; status: string } }>(
      client,
      flags,
      'orchestration.taskCreate',
      {
        spec: getRequiredStringFlag(flags, 'spec'),
        taskTitle: getOptionalStringFlag(flags, 'task-title'),
        displayName: getOptionalStringFlag(flags, 'display-name'),
        deps: getOptionalStringFlag(flags, 'deps'),
        parent: getOptionalStringFlag(flags, 'parent'),
        run: getOptionalStringFlag(flags, 'run'),
        callerTerminalHandle
      }
    )
    printOrchestrationResult(
      result,
      { flags, json },
      taskReceiptView((id, status) => `Created ${id} [${status}]`)
    )
  },

  'orchestration task-list': async ({ flags, client, cwd, json }) => {
    const brief = flags.has('brief')
    const run = getOptionalStringFlag(flags, 'run')
    const callerTerminalHandle = run
      ? runScopedSessionCaller(flags)
      : await resolveCoordinatorTerminalHandle(flags, cwd, client)
    const result = await client.call<TaskListResult>('orchestration.taskList', {
      status: getOptionalStringFlag(flags, 'status'),
      ready: flags.has('ready') ? true : undefined,
      brief: brief ? true : undefined,
      run,
      callerTerminalHandle
    })
    // Only hosts that omit spec_truncated need client-side abbreviation.
    const needsClientAbbreviation =
      brief && result.result.tasks.some((task) => task.spec_truncated === undefined)
    const output = needsClientAbbreviation
      ? {
          ...result,
          result: { ...result.result, tasks: abbreviateOrchestrationTasks(result.result.tasks) }
        }
      : result
    printOrchestrationResult(
      output,
      { flags, json },
      {
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
        }),
        fullText: formatTaskList
      }
    )
  },

  'orchestration task-update': async ({ flags, client, cwd, json }) => {
    const status = getRequiredStringFlag(flags, 'status')
    if (!TASK_STATUS_VALUES.includes(status as (typeof TASK_STATUS_VALUES)[number])) {
      throw new RuntimeClientError(
        'invalid_argument',
        `invalid status '${status}', expected one of: ${TASK_STATUS_VALUES.join(', ')}`
      )
    }
    const result = await callOrchestrationMutation<{ task: { id: string; status: string } }>(
      client,
      flags,
      'orchestration.taskUpdate',
      {
        id: getRequiredStringFlag(flags, 'id'),
        status,
        result: getOptionalStringFlag(flags, 'result'),
        run: getOptionalStringFlag(flags, 'run'),
        callerTerminalHandle: await resolveCoordinatorTerminalHandle(flags, cwd, client)
      }
    )
    printOrchestrationResult(
      result,
      { flags, json },
      taskReceiptView((id, status) => `Updated ${id} -> ${status}`)
    )
  }
}

type TaskReceipt = { task: { id: string; status: string } }

// The task row echoes the caller's spec back; the id and status are what it acts on.
function taskReceiptView(format: (taskId: string, status: string) => string) {
  return {
    fields: (value: TaskReceipt) => ({ taskId: value.task.id, status: value.task.status }),
    fullText: (value: TaskReceipt) => format(value.task.id, value.task.status)
  }
}

type TaskListResult = {
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

function formatTaskList(r: TaskListResult): string {
  if (r.count === 0) {
    return r.legacyReadOnly ? 'No legacy tasks (read-only).' : 'No tasks.'
  }
  const tasks = r.tasks
    .map((task) => {
      const label = task.display_name ?? task.task_title ?? task.spec
      const head = `${task.id} [${task.status}] ${label.slice(0, 60)}`
      if (task.status === 'dispatched' && task.assignee_handle) {
        return `${head} -> ${task.assignee_handle} (${task.dispatch_id ?? '?'})`
      }
      return head
    })
    .join('\n')
  return r.legacyReadOnly ? `Legacy Run ${r.runId} (read-only)\n${tasks}` : tasks
}
