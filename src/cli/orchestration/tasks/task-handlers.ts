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
import { escapeTerminalControlCharacters } from '../../../shared/terminal/output/terminal-control-character-escape'
import { ORCHESTRATION_TASK_UPDATE_NOTE_RUNTIME_CAPABILITY } from '../../../shared/orchestration/orchestration-runtime-capabilities'
import type { RuntimeStatus } from '../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { readInjectedAgentSessionId } from '../../../shared/agent-session/lifecycle/launch/agent-session-caller-env'
import { callOrchestrationMutation } from '../recovery/mutation-request'
import { readTextOrFileFlag } from '../../arguments/command-body-input'
import {
  resolveCoordinatorTerminalHandle,
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
          const assignment =
            task.status === 'dispatched' && task.assignee_handle
              ? ` -> ${task.assignee_handle} (${task.dispatch_id ?? '?'})`
              : ''
          const lines = [`${head}${assignment}`, `  Spec: ${task.spec.replace(/\r?\n/g, '\n    ')}`]
          if (task.result != null) {
            lines.push(`  Result: ${task.result.replace(/\r?\n/g, '\n    ')}`)
          }
          return escapeTerminalControlCharacters(lines.join('\n'))
        })
        .join('\n')
      return r.legacyReadOnly ? `Legacy Run ${r.runId} (read-only)\n${tasks}` : tasks
    })
  },

  'orchestration task-update': async ({ flags, client, cwd, json }) => {
    const hasStatus = flags.has('status')
    const hasNote = flags.has('note') || flags.has('note-file')
    if (hasStatus === hasNote) {
      throw new RuntimeClientError(
        'invalid_argument',
        hasStatus
          ? '--note is for passive worker updates and cannot be combined with --status.'
          : 'Choose --status or --note (or --note-file).'
      )
    }
    if (hasNote && flags.has('result')) {
      throw new RuntimeClientError('invalid_argument', '--result requires --status.')
    }
    let status: (typeof TASK_STATUS_VALUES)[number] | undefined
    if (hasStatus) {
      const requested = getRequiredStringFlag(flags, 'status')
      if (!isTaskStatusValue(requested)) {
        throw new RuntimeClientError(
          'invalid_argument',
          `invalid status '${requested}', expected one of: ${TASK_STATUS_VALUES.join(', ')}`
        )
      }
      status = requested
    }
    if (hasNote) {
      const runtimeStatus = await client.call<RuntimeStatus>('status.get')
      if (
        !runtimeStatus.result.capabilities?.includes(
          ORCHESTRATION_TASK_UPDATE_NOTE_RUNTIME_CAPABILITY
        )
      ) {
        throw new RuntimeClientError(
          'unsupported_capability',
          "This Orca doesn't support task-update --note yet."
        )
      }
    }
    const id = hasStatus ? getRequiredStringFlag(flags, 'id') : getOptionalStringFlag(flags, 'id')
    const note = hasNote ? await readTextOrFileFlag(flags, cwd, 'note', true) : undefined
    const callerTerminalHandle = await resolveCoordinatorTerminalHandle(flags, cwd, client)
    const senderPaneKey =
      !hasNote || callerTerminalHandle === undefined || readInjectedAgentSessionId()
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
        ...(senderPaneKey ? { senderPaneKey } : {})
      },
      dispatchCapability ? { orchestrationCapability: dispatchCapability } : undefined
    )
    if (!flags.has('full')) {
      printOrchestrationResult(result, json, TASK_RECEIPT_VIEW)
      return
    }
    printResult(result, json, (r) =>
      r.progressNote !== undefined
        ? `Recorded note on ${r.task.id}: ${r.progressNote}`
        : `Updated ${r.task.id} -> ${r.task.status}`
    )
  }
}
