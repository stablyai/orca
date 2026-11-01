import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import type { z } from 'zod'
import { defineMethod, type RpcContext } from '../../../core'
import { startFederatedWorker } from '../federation/federated-worker-start'
import { startLocalWorker } from './local-worker-start'
import type { WorkerFollowUp } from './worker-follow-up-placement'
import { withWorkerStartNext } from '../receipt-next'
import {
  decideWorkerStartMode,
  readWorkerStartModeSettings
} from '../../orchestration-worker-start-mode'
import { resolveOrchestrationCaller } from '../runs/run-scope'
import { assertHelperStartScope, resolveWorkerStartRun } from './worker-start-authority'
import { parseTaskDeps } from './task-deps-argument'
import { WorkerStartParams } from '../../../../../../shared/rpc-contract/orchestration-worker-start-params'
import {
  isWorkerStartTimeoutWithinTimerLimit,
  resolveWorkerStartReadinessTimeoutMs
} from '../../../../../../shared/orchestration-timing-budgets'
import { buildOrchestrationTaskDisplayMetadata } from '../../../../../../shared/orchestration-task-display'
import { assertWorkerStartTaskSpecWithinPromptBudget } from './worker-start-prompt-budget'
import { ORCA_SESSION_ADDRESS_PREFIX } from '../../../../../../shared/orca-session-address'
import { ORCHESTRATION_SESSION_CALLER_ERROR_CODES as SESSION_CODES } from '../../../../../../shared/orchestration-session-caller-codes'
import { resolveDispatchCreator } from '../runs/dispatch-creator'

type WorkerStartContext = Pick<
  RpcContext,
  'runtime' | 'orchestrationMutation' | 'orchestrationCompatibilityEvidence' | 'orchestrationCaller'
>

export const ORCHESTRATION_WORKER_START_METHODS = [
  defineMethod({
    name: 'orchestration.workerStart',
    requires: ['accounts'],
    permission: 'workspace',
    params: WorkerStartParams,
    handler: async (params, ctx) => startWorker(params, ctx)
  })
]

/** worker-start, and a follow-up sent to a finished worker, which is worker-start run for the sender. */
export async function startWorker(
  params: z.infer<typeof WorkerStartParams>,
  {
    runtime,
    orchestrationMutation,
    orchestrationCompatibilityEvidence,
    orchestrationCaller
  }: WorkerStartContext,
  followUp?: WorkerFollowUp
): Promise<unknown> {
  if (!isWorkerStartTimeoutWithinTimerLimit(params.timeoutMs)) {
    throw new OrchestrationError(
      'invalid_argument',
      '--timeout-ms is too large for worker-start transport grace; the derived timeout must fit within the timer limit.'
    )
  }
  if (params.on && params.terminal?.startsWith(ORCA_SESSION_ADDRESS_PREFIX)) {
    // Refused here, before any remote call: an Orca session ID names a chat only on its own host.
    throw new OrchestrationError(
      SESSION_CODES.hostBoundary,
      `${params.terminal} names a chat by its Orca session ID, which identifies it only on the host that runs it. Run worker-start on that host. No effects were applied.`,
      { effectsApplied: false }
    )
  }
  const readinessTimeoutMs = resolveWorkerStartReadinessTimeoutMs(params.timeoutMs)
  const db = runtime.getOrchestrationDb()
  const coordinator = resolveOrchestrationCaller(runtime, {
    callerTerminalHandle: params.from,
    callerEvidence: orchestrationCompatibilityEvidence,
    callerSession: orchestrationCaller
  })
  if (params.spec) {
    // Before the Run resolves, so a refused spec cannot leave a new Run bound.
    await assertWorkerStartTaskSpecWithinPromptBudget(params.spec)
  }
  const taskDeps = parseTaskDeps(params.deps)
  const { bindRun, helperCreator } = resolveWorkerStartRun(runtime, {
    coordinator,
    from: params.from,
    callerSession: orchestrationCaller,
    runId: params.run,
    // The Run takes the title its first Task gets.
    objective: params.spec
      ? buildOrchestrationTaskDisplayMetadata({
          spec: params.spec,
          taskTitle: params.taskTitle
        }).taskTitle
      : undefined,
    taskReferences: [...(params.parent ? [params.parent] : []), ...(taskDeps ?? [])]
  })
  // Name the Run in every receipt so a reused, stale binding is visible.
  const withRun = (receipt: unknown): unknown => {
    if (!receipt || typeof receipt !== 'object') {
      return receipt
    }
    const { run, created } = bindRun()
    return { ...receipt, run: { id: run.id, objective: run.objective, created } }
  }
  const existingTask = params.task ? db.getTask(params.task) : undefined
  // --task excludes --spec, so this never creates a Run.
  if (params.task && (!existingTask || existingTask.run_id !== bindRun().run.id)) {
    throw new OrchestrationError(
      'task_not_found',
      `Task ${params.task} was not found in Run ${bindRun().run.id}.`
    )
  }
  if (helperCreator) {
    assertHelperStartScope(db, helperCreator, {
      task: existingTask,
      params,
      ...(followUp ? { followUp } : {})
    })
  }
  if (existingTask) {
    await assertWorkerStartTaskSpecWithinPromptBudget(existingTask.spec)
  }
  if (followUp) {
    // Acceptance checks depth again; checking it here keeps an already refused start from closing a shell first.
    db.resolveChildDispatchDepth(
      resolveDispatchCreator(runtime, params.from, orchestrationCaller),
      runtime.getNestedWorkerMaxDepth()
    )
    const placement = await followUp.place(() => {
      if (
        helperCreator &&
        db.resolveCreatorDispatchId(
          resolveDispatchCreator(runtime, params.from, orchestrationCaller)
        ) !== helperCreator.id
      ) {
        throw new OrchestrationError(
          'consumer_fenced',
          `Dispatch ${helperCreator.id} is no longer this caller's active work. No effects were applied.`,
          { effectsApplied: false }
        )
      }
    })
    const spec = [
      params.spec,
      placement.delivery === 'started_fresh' ? placement.earlierWork : undefined
    ]
      .filter(Boolean)
      .join('\n\n')
    params = {
      ...params,
      worktree: `id:${placement.worktreeId}`,
      ...(placement.terminal ? { terminal: placement.terminal } : {}),
      ...(placement.agent ? { agent: placement.agent } : {}),
      ...(placement.model ? { model: placement.model } : {}),
      ...(placement.effort ? { effort: placement.effort } : {}),
      spec
    }
    followUp = { ...followUp, reopen: placement.reopen, earlierWork: placement.earlierWork }
    await assertWorkerStartTaskSpecWithinPromptBudget(spec)
  }
  const mode = decideWorkerStartMode({
    params,
    settings: readWorkerStartModeSettings(runtime)
  })
  if (params.on) {
    // Remote workers are terminal-only; carry the mode receipt to explain structured-preference fallback.
    const receipt = await startFederatedWorker({
      params,
      runtime,
      db,
      bindRunId: () => bindRun().run.id,
      task: existingTask,
      taskDeps,
      orchestrationMutation,
      callerSession: orchestrationCaller
    })
    return withRun(receipt && typeof receipt === 'object' ? { ...receipt, mode } : receipt)
  }
  const receipt = await startLocalWorker({
    params: { ...params, timeoutMs: readinessTimeoutMs },
    runtime,
    db,
    bindRun: () => bindRun().run,
    taskDeps,
    coordinator,
    callerSession: orchestrationCaller,
    existingTask,
    orchestrationMutation,
    mode,
    helperCreator,
    followUp
  })
  return withRun(withWorkerStartNext(receipt))
}
