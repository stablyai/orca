import type { MaestroTerminalLease } from '../../../shared/maestro-terminal-lease'
import type { MaestroBrowserSurfaceReceipt } from '../../../shared/maestro-browser-surface'
import {
  MAESTRO_RUN_PROGRESS_LIST_LIMIT,
  MaestroRunProgressV2Schema,
  type MaestroRunProgressV2
} from '../../../shared/maestro-run-progress'
import type { OrchestrationNestedAgentActivity } from '../../../shared/orchestration-nested-agent-activity'
import type { ExactWorkerProviderSession } from '../../../shared/orchestration-worker-output'
import { projectMaestroRunResources } from './maestro-run-resource-projection'
import { latestAcceptedDispatchMessage, parseProgressPayload } from './maestro-run-progress-message'
import type {
  DispatchContextRow,
  MessageRow,
  RunCompletion,
  RunRow,
  TaskRow,
  WorkerDispatchRow
} from './types'
import {
  projectOperationalTaskOutcome,
  projectTaskProgressOutcome,
  type TaskProgressOutcome
} from './db/tasks/task-progress-outcome'
import { disambiguateTaskProgressTitles } from './db/tasks/task-progress-title'
import { selectCurrentTaskDispatches } from './maestro-current-task-dispatch'
import type { MaestroTerminalLiveness } from './maestro-run-resource-state'
import { projectMaestroRunCompletion } from './maestro-run-completion-projection'
import { boundedText, compareCreatedRows } from './maestro-run-progress-text'

export type MaestroRunProgressProjectionInput = {
  run: RunRow
  tasks: readonly TaskRow[]
  dispatches: readonly DispatchContextRow[]
  messages: readonly MessageRow[]
  terminalLeases: readonly MaestroTerminalLease[]
  workerDispatches: readonly WorkerDispatchRow[]
  browserSurfaces: readonly MaestroBrowserSurfaceReceipt[]
  providerExecutions: readonly { dispatchId: string; session: ExactWorkerProviderSession }[]
  nestedActivity: readonly OrchestrationNestedAgentActivity[]
  executionHostId: string
  workspaceKey: string
  revision: number
  projectionHealth: MaestroRunProgressV2['projection_health']
  cleanupHealth: MaestroRunProgressV2['cleanup_health']
  recoveredAuthority: boolean
  browserSurfaceKeys: ReadonlyMap<string, string>
  terminalLiveness: ReadonlyMap<string, MaestroTerminalLiveness>
  completion?: RunCompletion
}

type TaskProjection = {
  task: TaskRow
  title: string
  workerLabel?: string
  dispatch?: DispatchContextRow
  outcome: TaskProgressOutcome
  operationalOutcome?: NonNullable<TaskRow['operational_outcome']>
}

export function projectMaestroRunProgress(
  input: MaestroRunProgressProjectionInput
): MaestroRunProgressV2 {
  const orderedTasks = [...input.tasks].sort(compareCreatedRows)
  const dispatchesByTask = new Map(
    selectCurrentTaskDispatches(orderedTasks, input.dispatches).map(
      (dispatch) => [dispatch.task_id, dispatch] as const
    )
  )
  const leasesByTask = new Map(
    [...input.terminalLeases]
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
      .flatMap((lease) => (lease.taskId ? [[lease.taskId, lease] as const] : []))
  )
  const titles = disambiguateTaskProgressTitles(orderedTasks, boundedText)
  const taskHistory = orderedTasks.map((task, index): TaskProjection => {
    const dispatch = dispatchesByTask.get(task.id)
    const lease = leasesByTask.get(task.id)
    const workerLabel = task.display_name?.trim()
    const title = titles[index] as string
    return {
      task,
      title,
      ...(workerLabel ? { workerLabel: boundedText(workerLabel, title) } : {}),
      ...(dispatch ? { dispatch } : {}),
      outcome: projectTaskProgressOutcome(task, dispatch, lease),
      ...(task.purpose === 'operational'
        ? { operationalOutcome: projectOperationalTaskOutcome(task, lease) }
        : {})
    }
  })
  const taskIds = new Set(orderedTasks.map((task) => task.id))
  const tasks = taskHistory.filter(
    ({ task }) =>
      task.operational_outcome !== 'superseded' ||
      !task.successor_task_id ||
      task.successor_task_id === task.id ||
      !taskIds.has(task.successor_task_id)
  )
  const counts: MaestroRunProgressV2['execution']['counts'] = {
    pending: 0,
    running: 0,
    input_required: 0,
    blocked: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0
  }
  for (const task of tasks) {
    counts[task.outcome] += 1
  }
  const completed = counts.succeeded + counts.failed + counts.cancelled
  const total = tasks.length
  const deliverableTasks = tasks.filter(({ task }) => task.purpose !== 'operational')
  const deliverableCompleted = deliverableTasks.filter(({ outcome }) =>
    ['succeeded', 'failed', 'cancelled'].includes(outcome)
  ).length
  const operationalReliability: NonNullable<MaestroRunProgressV2['operational_reliability']> = {
    successful: 0,
    failed: 0,
    superseded: 0,
    unverifiable: 0
  }
  for (const task of taskHistory) {
    if (task.operationalOutcome) {
      operationalReliability[task.operationalOutcome] += 1
    }
  }
  const executionState: MaestroRunProgressV2['execution']['state'] =
    total > 0 && completed === total
      ? counts.failed > 0
        ? 'completed_with_failures'
        : counts.cancelled > 0
          ? 'cancelled'
          : 'completed'
      : counts.blocked > 0
        ? 'blocked'
        : counts.input_required > 0
          ? 'input_required'
          : 'active'

  return MaestroRunProgressV2Schema.parse({
    schema_version: 2,
    run: { id: input.run.id, title: boundedText(input.run.objective, 'Untitled run') },
    execution: {
      state: executionState,
      ...(total > 0 ? { progress_percent: Math.round((completed / total) * 100) } : {}),
      completed,
      total,
      counts
    },
    deliverables: {
      ...(deliverableTasks.length
        ? { progress_percent: Math.round((deliverableCompleted / deliverableTasks.length) * 100) }
        : {}),
      completed: deliverableCompleted,
      total: deliverableTasks.length
    },
    operational_reliability: operationalReliability,
    projection_health: input.projectionHealth,
    cleanup_health: input.cleanupHealth,
    current: tasks
      .filter(({ outcome }) => ['running', 'input_required', 'blocked'].includes(outcome))
      .slice(0, MAESTRO_RUN_PROGRESS_LIST_LIMIT)
      .map((task) => ({
        reference: task.task.id,
        title: task.title,
        worker_label: task.workerLabel,
        state: task.outcome,
        activity_summary: currentActivity(task, input.messages)
      })),
    recently_completed: tasks
      .filter(({ outcome }) => ['succeeded', 'failed', 'cancelled'].includes(outcome))
      .sort(
        (left, right) =>
          (right.task.completed_at ?? right.task.created_at).localeCompare(
            left.task.completed_at ?? left.task.created_at
          ) || right.task.id.localeCompare(left.task.id)
      )
      .slice(0, MAESTRO_RUN_PROGRESS_LIST_LIMIT)
      .map((task) => ({
        reference: task.task.id,
        title: task.title,
        worker_label: task.workerLabel,
        outcome_summary: completedOutcome(task),
        purpose: task.task.purpose ?? 'deliverable',
        ...(task.operationalOutcome ? { operational_outcome: task.operationalOutcome } : {}),
        ...(task.task.successor_task_id ? { successor_reference: task.task.successor_task_id } : {})
      })),
    next: tasks
      .filter(({ outcome }) => outcome === 'pending')
      .slice(0, MAESTRO_RUN_PROGRESS_LIST_LIMIT)
      .map((task) => ({
        reference: task.task.id,
        title: task.title,
        worker_label: task.workerLabel,
        next_step: boundedText(task.task.spec, task.title)
      })),
    blocked: tasks
      .filter(({ outcome }) => outcome === 'blocked')
      .slice(0, MAESTRO_RUN_PROGRESS_LIST_LIMIT)
      .map((task) => ({
        reference: task.task.id,
        title: task.title,
        worker_label: task.workerLabel,
        blocker_summary: blockerSummary(task, input.messages)
      })),
    nested_activity: [...input.nestedActivity]
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at))
      .slice(0, MAESTRO_RUN_PROGRESS_LIST_LIMIT)
      .map((activity) => ({
        parent_reference:
          input.dispatches.find((dispatch) => dispatch.id === activity.parent_dispatch_id)
            ?.task_id ?? activity.parent_dispatch_id,
        child_id: activity.provider_child_id,
        label: boundedText(activity.description, activity.type),
        ...(activity.model ? { model: boundedText(activity.model, activity.provider) } : {}),
        state: activity.state,
        activity_summary: boundedText(activity.description, activity.type)
      })),
    ...projectMaestroRunCompletion(input.completion),
    resources: projectMaestroRunResources({
      run: input.run,
      tasks,
      dispatches: input.dispatches,
      workerDispatches: input.workerDispatches,
      terminalLeases: input.terminalLeases,
      browserSurfaces: input.browserSurfaces,
      providerExecutions: input.providerExecutions,
      nestedActivity: input.nestedActivity,
      executionHostId: input.executionHostId,
      workspaceKey: input.workspaceKey,
      recoveredAuthority: input.recoveredAuthority,
      browserSurfaceKeys: input.browserSurfaceKeys,
      terminalLiveness: input.terminalLiveness
    }),
    technical: {
      execution_host_id: input.executionHostId,
      workspace_key: input.workspaceKey,
      run_id: input.run.id,
      revision: input.revision
    }
  })
}

function currentActivity(task: TaskProjection, messages: readonly MessageRow[]): string {
  const message = latestAcceptedDispatchMessage(task.dispatch, messages, ['heartbeat', 'status'])
  if (message) {
    const payload = parseProgressPayload(message.payload)
    const phase = ['progressSubject', 'progress_subject', 'phase']
      .map((key) => payload?.[key])
      .find((value): value is string => typeof value === 'string' && Boolean(value.trim()))
    const subject = message.subject.trim()
    if (subject && subject.toLowerCase() !== 'alive') {
      return boundedText(subject, task.title)
    }
    if (phase) {
      return boundedText(phase, task.title)
    }
  }
  return boundedText(task.task.spec, task.title)
}

function blockerSummary(task: TaskProjection, messages: readonly MessageRow[]): string {
  const message = latestAcceptedDispatchMessage(task.dispatch, messages, [
    'escalation',
    'decision_gate'
  ])
  return boundedText(
    message?.subject ?? acceptedTaskResult(task.task.result) ?? task.task.spec,
    task.title
  )
}

function completedOutcome(task: TaskProjection): string {
  const fallback =
    task.outcome === 'succeeded'
      ? 'Completed'
      : task.outcome === 'cancelled'
        ? 'Cancelled'
        : 'Failed'
  return boundedText(acceptedTaskResult(task.task.result) ?? fallback, fallback)
}

function acceptedTaskResult(result: string | null): string | undefined {
  if (!result) {
    return undefined
  }
  const payload = parseProgressPayload(result)
  if (payload?.provenance !== 'worker_report') {
    return result
  }
  for (const field of [payload.body, payload.subject]) {
    if (typeof field === 'string' && field.trim()) {
      return field
    }
  }
  return undefined
}
