import type { z } from 'zod'
import {
  defineOrchestrationMethod,
  type OrchestrationAccessRuleInput
} from '../access/orchestration-method-access'
import { coordinatedRunAccess } from '../access/run-access-rules'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import type {
  DispatchContextRow,
  RunRow,
  TaskRow
} from '../../../../orchestration/db/orchestration-records'
import { isSelfCreatedDispatch } from '../../../../orchestration/db/dispatch-creator-evaluation'
import { exposeUtcTimestamp } from '../../../../orchestration/db/utc-timestamp'
import { assertWorkerCanReport } from '../../../../orchestration/workers/reports/worker-report-admission'
import { resolveWorkerReporterIdentity } from '../../../../orchestration/workers/reports/reminted-worker-reporter'
import { assertLifecycleCallerIsNotAnotherParty } from './lifecycle-caller-fence'
import { TaskUpdateParams } from './task-update-params'

type TaskUpdateInput = z.infer<typeof TaskUpdateParams>

export type TaskUpdateGrant =
  | { kind: 'worker'; task: TaskRow; dispatch: DispatchContextRow }
  | { kind: 'coordinator'; run: RunRow; task: TaskRow }

function tryCoordinatedRunTask(
  input: OrchestrationAccessRuleInput<TaskUpdateInput>,
  taskId: string
): TaskUpdateGrant | null {
  const db = input.ctx.runtime.getOrchestrationDb()
  const target = db.getTask(taskId)
  if (!target) {
    return null
  }
  try {
    const { run } = coordinatedRunAccess({
      ...input,
      params: { run: input.params.run ?? target.run_id }
    })
    return run.id === target.run_id ? { kind: 'coordinator', run, task: target } : null
  } catch {
    return null
  }
}

export function resolveTaskUpdateAccess(
  input: OrchestrationAccessRuleInput<TaskUpdateInput>
): TaskUpdateGrant {
  const { params, ctx, caller } = input
  const runtime = ctx.runtime
  const db = runtime.getOrchestrationDb()
  const from = caller ?? ctx.orchestrationCaller?.address ?? 'unknown'

  if (ctx.orchestrationCaller?.kind === 'peer') {
    if (!params.id) {
      throw new OrchestrationError('invalid_argument', 'Missing --id', { effectsApplied: false })
    }
    const { run } = coordinatedRunAccess(input)
    const existing = db.getTask(params.id)
    if (!existing || existing.run_id !== run.id) {
      throw new OrchestrationError(
        'task_not_found',
        `Task ${params.id} was not found in Run ${run.id}.`
      )
    }
    return { kind: 'coordinator', run, task: existing }
  }

  const reporter = resolveWorkerReporterIdentity(runtime, db, {
    from,
    authority: ctx.orchestrationCompatibilityCallerAuthority,
    hasSessionCaller: Boolean(ctx.orchestrationCaller),
    evidence: ctx.orchestrationCompatibilityEvidence,
    candidateDispatchId: undefined
  })
  const paneKey = reporter.paneKey ?? params.senderPaneKey ?? undefined

  const remoteAttachment = paneKey ? db.findActiveRemoteAttachmentForPane(paneKey) : undefined
  if (remoteAttachment && paneKey) {
    if (params.id && params.id !== remoteAttachment.task_id) {
      throw new OrchestrationError(
        'sender_not_assignee',
        `Worker ${from} owns active task ${remoteAttachment.task_id}, not ${params.id}. Omit --id to update your own active task.`,
        { effectsApplied: false }
      )
    }
    throw new OrchestrationError(
      'unsupported_remote_dispatch',
      `Passive task-update notes are not supported for legacy remote-attached Dispatch ${remoteAttachment.dispatch_id}. No effects were applied.`,
      { effectsApplied: false }
    )
  }

  const workingDispatch = db.getActiveDispatchForIdentity(from, paneKey)
  if (workingDispatch) {
    if (params.id !== undefined && params.id !== workingDispatch.task_id) {
      const coordinatedGrant = tryCoordinatedRunTask(input, params.id)
      if (coordinatedGrant) {
        return coordinatedGrant
      }
      throw new OrchestrationError(
        'sender_not_assignee',
        `Worker ${from} owns active task ${workingDispatch.task_id}, not ${params.id}. Omit --id to update your own active task.`,
        { effectsApplied: false }
      )
    }
    if (!ctx.orchestrationCaller) {
      assertLifecycleCallerIsNotAnotherParty(runtime, {
        from,
        fromPaneKey: paneKey,
        evidence: ctx.orchestrationCompatibilityEvidence
      })
    }
    assertWorkerCanReport({
      dispatchId: workingDispatch.id,
      from,
      workerState: db.getWorkerDispatch(workingDispatch.id)?.state,
      processCurrent:
        !workingDispatch.process_incarnation ||
        db.isDispatchProcessCurrent({
          dispatchId: workingDispatch.id,
          paneKey: paneKey ?? null,
          processIncarnation: reporter.processIncarnation()
        })
    })
    if (params.run !== undefined && params.run !== workingDispatch.run_id) {
      throw new OrchestrationError(
        'task_not_found',
        `Task ${workingDispatch.task_id} was not found in Run ${params.run}.`,
        { effectsApplied: false }
      )
    }
    const task = db.getTask(workingDispatch.task_id)
    if (!task) {
      throw new OrchestrationError(
        'task_not_found',
        `Task ${workingDispatch.task_id} was not found.`,
        { effectsApplied: false }
      )
    }
    return { kind: 'worker', task, dispatch: workingDispatch }
  }

  const latestCandidate = db.getLatestDispatchForTerminal(from, paneKey)
  const latestSettledWorker =
    latestCandidate && !isSelfCreatedDispatch(latestCandidate) ? latestCandidate : undefined

  if (!params.id) {
    if (latestSettledWorker) {
      throw new OrchestrationError(
        'dispatch_inactive',
        `Dispatch ${latestSettledWorker.id} for task ${latestSettledWorker.task_id} is ${latestSettledWorker.status}; passive task-update --note applies only while your worker Dispatch is active. (send = always wakes the recipient; task-update --note = passive, never wakes.)`,
        { effectsApplied: false }
      )
    }
    throw new OrchestrationError(
      'dispatch_inactive',
      'task-update without --id requires an active worker Dispatch; pass --id <task_id> when updating a task in your coordinated Run. (send = always wakes the recipient; task-update --note = passive, never wakes.)',
      { effectsApplied: false }
    )
  }

  try {
    const { run } = coordinatedRunAccess(input)
    const existing = db.getTask(params.id)
    if (!existing || existing.run_id !== run.id) {
      throw new OrchestrationError(
        'task_not_found',
        `Task ${params.id} was not found in Run ${run.id}.`
      )
    }
    return { kind: 'coordinator', run, task: existing }
  } catch (error) {
    if (latestSettledWorker) {
      if (latestSettledWorker.task_id === params.id) {
        throw new OrchestrationError(
          'dispatch_inactive',
          `Dispatch ${latestSettledWorker.id} for task ${latestSettledWorker.task_id} is ${latestSettledWorker.status}; passive task-update --note applies only while your worker Dispatch is active. (send = always wakes the recipient; task-update --note = passive, never wakes.)`,
          { effectsApplied: false }
        )
      }
      throw new OrchestrationError(
        'sender_not_assignee',
        `Worker ${from} does not own task ${params.id}.`,
        { effectsApplied: false }
      )
    }
    throw error
  }
}

export const ORCHESTRATION_TASK_UPDATE_METHOD = defineOrchestrationMethod({
  name: 'orchestration.taskUpdate',
  permission: 'workspace',
  params: TaskUpdateParams,
  access: {
    kind: 'writes',
    caller: 'callerTerminalHandle',
    callerPane: 'senderPaneKey',
    targets: { id: 'task', run: 'run' },
    rule: resolveTaskUpdateAccess
  },
  handler: (params, { runtime, recordMutationReceipt }, grant) => {
    const db = runtime.getOrchestrationDb()
    let task: TaskRow | undefined = grant.task
    if (params.status !== undefined) {
      if (grant.kind === 'worker') {
        if (params.status !== 'dispatched' || params.result !== undefined) {
          throw new OrchestrationError(
            'task_not_startable',
            `Task ${grant.task.id} cannot move to ${params.status} while supervised Dispatch ${grant.dispatch.id} is active; finish with orca orchestration send --type worker_done.`,
            { taskId: grant.task.id, dispatchId: grant.dispatch.id, effectsApplied: false }
          )
        }
      } else {
        task = db.updateTaskStatus(grant.task.id, params.status, params.result)
        if (!task) {
          throw new OrchestrationError('task_not_found', `Task not found: ${grant.task.id}`)
        }
      }
    }

    const recorded =
      params.note !== undefined
        ? db.recordWorkerProgress({
            taskId: grant.task.id,
            dispatchId: grant.kind === 'worker' ? grant.dispatch.id : undefined,
            note: params.note
          })
        : null
    if (recorded) {
      task = recorded.task
    }

    const finalTask = db.getTask(grant.task.id) ?? task
    if (!finalTask) {
      throw new OrchestrationError('task_not_found', `Task not found: ${grant.task.id}`)
    }

    const receipt = {
      task: finalTask,
      ...(recorded
        ? {
            ...(recorded.dispatchId ? { dispatchId: recorded.dispatchId } : {}),
            progressNote: recorded.note,
            progressUpdatedAt: exposeUtcTimestamp(recorded.updatedAt) ?? recorded.updatedAt
          }
        : {})
    }
    recordMutationReceipt?.(receipt)
    return receipt
  }
})
