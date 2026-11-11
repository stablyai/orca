import { stopHelperAfterStart } from './worker-stop'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import type { z } from 'zod'
import type { RpcContext } from '../../../core'
import { defineOrchestrationMethod } from '../access/orchestration-method-access'
import { startFederatedWorker } from '../../../../orchestration/legacy-remote-home/legacy-remote-home'
import { startLocalWorker } from './local-worker-start'
import type { WorkerFollowUp } from './worker-follow-up-placement'
import { withWorkerStartNext } from '../receipt-next'
import {
  decideWorkerStartMode,
  readWorkerStartModeSettings
} from '../structured-workers/orchestration-worker-start-mode'
import { resolveOrchestrationCaller } from '../runs/run-scope'
import {
  assertHelperStartScope,
  resolveWorkerStartRun,
  qualifyLiveWorkerFollowUp
} from './worker-start-authority'
import { parseTaskDeps } from './task-deps-argument'
import { resolveWorkerRoleParams } from '../../../../../../shared/orchestration-worker-roles'
import { FederationWorkerLaunchParams } from '../../../../../../shared/rpc-contract/orchestration-federation-start-params'
import { prepareFederationWorkerLaunchOnHost } from './worker-opencode-model-preflight'
import { WorkerStartParams } from '../../../../../../shared/rpc-contract/orchestration-worker-start-params'
import {
  isWorkerStartTimeoutWithinTimerLimit,
  resolveWorkerStartReadinessTimeoutMs
} from '../../../../../../shared/orchestration/orchestration-timing-budgets'
import { buildOrchestrationTaskDisplayMetadata } from '../../../../../../shared/orchestration/orchestration-task-display'
import { assertWorkerStartTaskSpecWithinPromptBudget } from './worker-start-prompt-budget'
import { ORCA_SESSION_ADDRESS_PREFIX } from '../../../../../../shared/orca-session-address-prefix'
import { ORCHESTRATION_SESSION_CALLER_ERROR_CODES as SESSION_CODES } from '../../../../../../shared/orchestration/orchestration-session-caller-codes'
import { resolveDispatchCreator } from '../runs/dispatch-creator'

type WorkerStartContext = Pick<
  RpcContext,
  'runtime' | 'orchestrationMutation' | 'orchestrationCompatibilityEvidence' | 'orchestrationCaller'
>

export const ORCHESTRATION_WORKER_START_METHODS = [
  defineOrchestrationMethod({
    name: 'orchestration.workerStart',
    access: {
      kind: 'writes',
      caller: 'from',
      server: 'on',
      targets: {
        task: 'task',
        parent: 'task',
        deps: 'task',
        run: 'run',
        retryOf: 'dispatch',
        terminal: 'worker',
        adoptTaskId: 'task'
      }
    },
    requires: ['accounts'],
    permission: 'workspace',
    params: WorkerStartParams,
    handler: async (params, ctx) => startWorker(params, ctx)
  }),
  defineOrchestrationMethod({
    name: 'orchestration.workerLaunchPreflight',
    access: { kind: 'reads', targets: { terminal: 'worker' } },
    permission: 'workspace',
    params: FederationWorkerLaunchParams,
    handler: async (params, { runtime }) => {
      if (params.worktree === 'current' || params.worktree === 'new-child') {
        throw new OrchestrationError(
          'invalid_argument',
          'Remote launch preflight requires an exact worktree selector or new-top-level.'
        )
      }
      const { launch } = await prepareFederationWorkerLaunchOnHost({
        params,
        createsWorktree: params.worktree === 'new-top-level',
        runtime
      })
      return { launch: { ...launch.receipt, effective: null } }
    }
  })
]

/** worker-start, and a follow-up sent to a finished worker, which is worker-start run for the sender. */
export async function startWorker(
  startParams: z.infer<typeof WorkerStartParams>,
  ctx: WorkerStartContext,
  startFollowUp?: WorkerFollowUp
): Promise<unknown> {
  const { runtime, orchestrationMutation, orchestrationCaller } = ctx
  const prepared = await prepareWorkerStart(startParams, ctx, startFollowUp)
  const { params, followUp, coordinator, bindRun, helperCreator, taskDeps, existingTask, withRun } =
    prepared
  const db = runtime.getOrchestrationDb()
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
    await stopHelperAfterStart(runtime, receipt, orchestrationMutation)
    return withRun(receipt && typeof receipt === 'object' ? { ...receipt, mode } : receipt)
  }
  const receipt = await startLocalWorker({
    params: { ...params, timeoutMs: resolveWorkerStartReadinessTimeoutMs(params.timeoutMs) },
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
  await stopHelperAfterStart(runtime, receipt, orchestrationMutation)
  return withRun(withWorkerStartNext(receipt))
}

/** What every start checks and binds before it is placed, here or on a paired server. */
export async function prepareWorkerStart(
  params: z.infer<typeof WorkerStartParams>,
  {
    runtime,
    orchestrationCompatibilityEvidence,
    orchestrationCaller
  }: Omit<WorkerStartContext, 'orchestrationMutation'>,
  followUp?: WorkerFollowUp
) {
  if (params.role) {
    try {
      params = resolveWorkerRoleParams(
        params,
        runtime.requireStore().getSettings().orchestrationWorkerRoles
      )
    } catch (error) {
      throw new OrchestrationError(
        'invalid_argument',
        error instanceof Error ? error.message : 'Invalid worker role profile.',
        { effectsApplied: false }
      )
    }
  }
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
  if (params.adoptTaskId !== undefined && orchestrationCaller?.kind !== 'peer') {
    throw new OrchestrationError(
      'invalid_argument',
      'Only the paired Orca coordinating a Run names its Task IDs. No effects were applied.',
      { effectsApplied: false }
    )
  }
  const placement = params.worktree ?? 'current'
  if (
    orchestrationCaller?.kind === 'peer' &&
    !followUp &&
    !params.terminal &&
    /^(current|new-child)$/.test(placement)
  ) {
    throw new OrchestrationError(
      'invalid_argument',
      `--on requires an exact remote worktree selector or new-top-level: ${orchestrationCaller.peerRun.home_label} has no workspace on this server for --worktree ${placement}. No effects were applied.`,
      { effectsApplied: false }
    )
  }
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
  const qualified = followUp
    ? qualifyLiveWorkerFollowUp(
        runtime,
        coordinator,
        params.from,
        orchestrationCaller,
        params.run!,
        followUp
      )
    : undefined
  const { bindRun, helperCreator } = qualified
    ? { bindRun: () => ({ run: qualified.run, created: false }), helperCreator: qualified.creator }
    : resolveWorkerStartRun(runtime, {
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
  if (helperCreator && !followUp) {
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
  return {
    params,
    followUp,
    coordinator,
    bindRun,
    helperCreator,
    taskDeps,
    existingTask,
    withRun
  }
}
