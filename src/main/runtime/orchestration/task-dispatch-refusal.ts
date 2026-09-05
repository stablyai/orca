import type { OrchestrationDb } from './db'
import { OrchestrationError } from './orchestration-error'
import type { TaskRow } from './types'
import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'

// Why: dispatch and worker-start used to flatten these to runtime_error, so an agent reading the
// receipt could not tell "create the task" from "wait on deps" from "pick another terminal".
// Recovery rides in data.nextSteps, which every shipped CLI already prints for any code.

export function taskNotFoundError(taskId: string, runId?: string): OrchestrationError {
  return new OrchestrationError(
    'task_not_found',
    runId ? `Task ${taskId} was not found in Run ${runId}.` : `Task ${taskId} was not found.`,
    {
      taskId,
      ...(runId ? { runId } : {}),
      nextSteps: [
        'Run orca orchestration task-list --json in the bound Run to find the intended Task id.',
        'If the Task does not exist yet, create it with orca orchestration task-create --spec <text> --json.'
      ]
    }
  )
}

export function taskNotReadyError(db: OrchestrationDb, task: TaskRow): OrchestrationError {
  const unmetDependencies = unmetTaskDependencies(db, task)
  const nextSteps =
    unmetDependencies.length > 0
      ? [
          `Wait for ${unmetDependencies.join(', ')} to complete (orca orchestration check --wait --json), then dispatch again.`
        ]
      : task.status === 'dispatched'
        ? [
            'The Task already has an active Dispatch; inspect it with orca orchestration dispatch-show --task <task_id> --json.'
          ]
        : [
            `A ${task.status} Task cannot be dispatched; create a new Task or use worker-start --retry-of for a failed attempt.`
          ]
  return new OrchestrationError(
    'task_not_ready',
    `Task ${task.id} is ${task.status}; only ready tasks can be dispatched`,
    { taskId: task.id, status: task.status, unmetDependencies, nextSteps }
  )
}

// Why: the old five-name example read as an allowlist (#15125); derive from the field detection keys on so it cannot drift.
// Not filtered by `disabledTuiAgents` — that gates Orca's launchers, not detection, so a hand-started disabled agent still injects.
const RECOGNIZED_AGENT_PROCESS_NAMES = [
  ...new Set(Object.values(TUI_AGENT_CONFIG).map((config) => config.expectedProcess))
].sort()

export function buildInjectRejectionMessage(terminal: string): string {
  return (
    `Cannot dispatch --inject to terminal ${terminal}: no recognized agent detected. ` +
    `Orca detects these agent CLIs (${RECOGNIZED_AGENT_PROCESS_NAMES.join(', ')}). ` +
    'Start one in the terminal and let it finish launching, ' +
    'or dispatch without --inject and send the prompt manually.'
  )
}

export type InjectRejectionReason = 'no_agent_detected'

export function injectRejectedError(
  terminal: string,
  reason: InjectRejectionReason
): OrchestrationError {
  return new OrchestrationError('inject_rejected', buildInjectRejectionMessage(terminal), {
    terminal,
    reason,
    nextSteps: [
      'Start a recognized agent CLI in that terminal and wait for it to finish launching, or pick a terminal that already runs one.',
      'Alternatively dispatch without --inject and deliver the prompt with orca terminal send --terminal <handle> --text <prompt> --enter --json.'
    ]
  })
}

function unmetTaskDependencies(db: OrchestrationDb, task: TaskRow): string[] {
  let deps: unknown
  try {
    deps = JSON.parse(task.deps)
  } catch {
    return []
  }
  if (!Array.isArray(deps)) {
    return []
  }
  return deps.filter(
    (dep): dep is string => typeof dep === 'string' && db.getTask(dep)?.status !== 'completed'
  )
}
