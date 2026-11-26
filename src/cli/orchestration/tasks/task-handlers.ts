import type { CommandHandler } from '../../dispatch/dispatch'
import { printResult } from '../../output/command-result-output'
import { printOrchestrationResult } from '../agent-view'
import {
  TASK_LIST_VIEW,
  TASK_RECEIPT_VIEW,
  type TaskListResult,
  type TaskReceiptResult
} from './task-agent-views'
import { getOptionalStringFlag, getRequiredStringFlag } from '../../arguments/flags'
import { RuntimeClientError } from '../../runtime/connection/types'
import { abbreviateOrchestrationTasks } from '../../../shared/orchestration/orchestration-task-summary'
import { ORCHESTRATION_PROGRESS_NOTE_MAX } from '../../../shared/rpc-contract/orchestration/orchestration-params'
import { readInjectedAgentSessionId } from '../../../shared/agent-session/lifecycle/launch/agent-session-caller-env'
import { callOrchestrationMutation } from '../recovery/mutation-request'
import { readTextOrFileFlag } from '../../arguments/command-body-input'
import {
  resolveCoordinatorTerminalHandle,
  resolveOrchestrationTerminalHandle,
  runScopedSessionCaller
} from '../identity/terminal-identity'

const TASK_STATUS_VALUES = [
  'pending',
  'ready',
  'dispatched',
  'completed',
  'failed',
  'blocked'
] as const

const TASK_STATUS_SET: ReadonlySet<string> = new Set(TASK_STATUS_VALUES)

function isTaskStatusValue(value: string): value is (typeof TASK_STATUS_VALUES)[number] {
  return TASK_STATUS_SET.has(value)
}

export const ORCHESTRATION_TASK_HANDLERS: Record<string, CommandHandler> = {
  'orchestration task-create': async ({ flags, client, cwd, json }) => {
    const callerTerminalHandle = await resolveCoordinatorTerminalHandle(flags, cwd, client)
    const result = await callOrchestrationMutation<TaskReceiptResult>(
      client,
      flags,
      'orchestration.taskCreate',
      {
        spec: await readTextOrFileFlag(flags, cwd, 'spec', true),
        taskTitle: getOptionalStringFlag(flags, 'task-title'),
        displayName: getOptionalStringFlag(flags, 'display-name'),
        deps: getOptionalStringFlag(flags, 'deps'),
        parent: getOptionalStringFlag(flags, 'parent'),
        run: getOptionalStringFlag(flags, 'run'),
        callerTerminalHandle
      }
    )
    if (!flags.has('full')) {
      printOrchestrationResult(result, json, TASK_RECEIPT_VIEW)
      return
    }
    printResult(result, json, (r) => `Created ${r.task.id} [${r.task.status}]`)
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
    if (!flags.has('full')) {
      printOrchestrationResult(output, json, TASK_LIST_VIEW)
      return
    }
    printResult(output, json, (r) => {
      if (r.count === 0) {
        return r.legacyReadOnly ? 'No legacy tasks (read-only).' : 'No tasks.'
      }
      const tasks = r.tasks
        .map((task) => {
          const label = task.display_name ?? task.task_title ?? task.spec
          const head = `${task.id} [${task.status}] ${label.slice(0, 60)}`
          const noteSuffix = task.progress_note ? ` — ${task.progress_note}` : ''
          if (task.status === 'dispatched' && task.assignee_handle) {
            return `${head} -> ${task.assignee_handle} (${task.dispatch_id ?? '?'})${noteSuffix}`
          }
          return `${head}${noteSuffix}`
        })
        .join('\n')
      return r.legacyReadOnly ? `Legacy Run ${r.runId} (read-only)\n${tasks}` : tasks
    })
  },

  'orchestration task-update': async ({ flags, client, cwd, json }) => {
    const hasStatus = flags.has('status')
    const hasNote = flags.has('note') || flags.has('note-file')
    if (!hasStatus && !hasNote) {
      throw new RuntimeClientError(
        'invalid_argument',
        'Choose --status, --note (or --note-file), or both.'
      )
    }
    if (!hasStatus && flags.has('result')) {
      throw new RuntimeClientError('invalid_argument', '--result requires --status.')
    }
    let status: (typeof TASK_STATUS_VALUES)[number] | undefined
    if (hasStatus) {
      const requestedStatus = getRequiredStringFlag(flags, 'status')
      if (!isTaskStatusValue(requestedStatus)) {
        throw new RuntimeClientError(
          'invalid_argument',
          `invalid status '${requestedStatus}', expected one of: ${TASK_STATUS_VALUES.join(', ')}`
        )
      }
      status = requestedStatus
    }

    let note: string | undefined
    if (hasNote) {
      const rawNote = await readTextOrFileFlag(flags, cwd, 'note', true)
      const trimmed = rawNote?.trim() ?? ''
      if (!trimmed) {
        throw new RuntimeClientError('invalid_argument', '--note cannot be empty.')
      }
      if (trimmed.length > ORCHESTRATION_PROGRESS_NOTE_MAX) {
        throw new RuntimeClientError(
          'invalid_argument',
          `--note must be at most ${ORCHESTRATION_PROGRESS_NOTE_MAX} characters (received ${trimmed.length}); put longer details in your final worker_done report.`
        )
      }
      note = trimmed
    }

    const id = getOptionalStringFlag(flags, 'id')
    if (
      !id &&
      !getOptionalStringFlag(flags, 'from') &&
      !process.env.ORCA_TERMINAL_HANDLE &&
      !readInjectedAgentSessionId()
    ) {
      throw new RuntimeClientError(
        'dispatch_inactive',
        'orchestration task-update without --id requires an active worker session or --from <worker_handle>; pass --id <task_id> to update a coordinated task. (send = always wakes the recipient; task-update --note = passive, never wakes.)'
      )
    }

    const callerTerminalHandle = await resolveOrchestrationTerminalHandle(
      flags,
      cwd,
      client,
      'from',
      {
        validateEnvHandle: hasStatus
      }
    )
    const senderPaneKey =
      callerTerminalHandle === undefined || readInjectedAgentSessionId()
        ? undefined
        : process.env.ORCA_PANE_KEY || undefined
    const dispatchCapability = getOptionalStringFlag(flags, 'dispatch-capability')
    const result = await callOrchestrationMutation<TaskReceiptResult>(
      client,
      flags,
      'orchestration.taskUpdate',
      {
        id,
        status,
        result: getOptionalStringFlag(flags, 'result'),
        note,
        run: getOptionalStringFlag(flags, 'run'),
        callerTerminalHandle,
        senderPaneKey
      },
      dispatchCapability ? { orchestrationCapability: dispatchCapability } : undefined
    )
    if (!flags.has('full')) {
      printOrchestrationResult(result, json, TASK_RECEIPT_VIEW)
      return
    }
    printResult(result, json, (r) =>
      r.progressNote !== undefined && !hasStatus
        ? `Recorded note on ${r.task.id} [${r.task.status}]: ${r.progressNote}`
        : `Updated ${r.task.id} -> ${r.task.status}${r.progressNote ? ` (${r.progressNote})` : ''}`
    )
  }
}
