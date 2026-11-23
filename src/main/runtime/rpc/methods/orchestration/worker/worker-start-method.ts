import { stopHelperAfterStart } from './worker-stop'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import type { z } from 'zod'
import type { RpcContext } from '../../../core'
import { defineOrchestrationMethod } from '../access/orchestration-method-access'
import { startFederatedWorker } from '../../../../orchestration/legacy-remote-home/federated-worker-start'
import { startLocalWorker } from './start/local-worker-start'
import type { WorkerFollowUp } from './follow-up/worker-follow-up-placement'
import { withWorkerStartNext } from '../receipt-next'
import { resolveOrchestrationCaller } from '../runs/run-scope'
import {
  assertHelperStartScope,
  assertWorkerStartPlacementBoundaries,
  resolveWorkerStartRun,
  qualifyLiveWorkerFollowUp
} from './start/admission/worker-start-authority'
import { parseTaskDeps } from './start/admission/task-deps-argument'
import { WorkerStartParams } from '../../../../../../shared/rpc-contract/orchestration/orchestration-worker-start-params'
import {
  isWorkerStartTimeoutWithinTimerLimit,
  resolveWorkerStartReadinessTimeoutMs
} from '../../../../../../shared/orchestration/orchestration-timing-budgets'
import { buildOrchestrationTaskDisplayMetadata } from '../../../../../../shared/orchestration/orchestration-task-display'
import { assertWorkerStartTaskSpecWithinPromptBudget } from './start/admission/worker-start-prompt-budget'
import { resolveDispatchCreator } from '../runs/dispatch-creator'
import { resolveBotTurnWorkTargetForCaller } from '../../../../../bots/bot-turn-work-target'
import { resolveVerifiedFollowUpWorkTarget } from '../../../../../bots/bot-work-target-unread-provenance'
import type { ResolvedBotWorkTargetPlacement } from '../../../../../../shared/agent-session/work-target/agent-session-work-target'
import { checkedWorkerOrigin } from '../../bots-items-worker-origin'
import { decideStartMode, noteTerminalFallbackOnItem } from './start/worker-chat-lineage'
import { withKeepOpenDefault } from './start/worker-keep-open-default'
import {
  linkWorkerToQuestion,
  openQuestionReminder,
  withOpenQuestion,
  withQuestionLink
} from './start/worker-question-link'

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
  })
]

/** worker-start, and a follow-up sent to a finished worker, which is worker-start run for the sender. */
export async function startWorker(
  startParams: z.infer<typeof WorkerStartParams>,
  ctx: WorkerStartContext,
  startFollowUp?: WorkerFollowUp
): Promise<unknown> {
  const { runtime, orchestrationMutation, orchestrationCaller } = ctx
  if (startParams.origin !== undefined && startParams.on) {
    throw new OrchestrationError(
      'invalid_argument',
      'worker-start --item starts workers on this computer, where the item is. No effects were applied.',
      { effectsApplied: false }
    )
  }
  const checked =
    startParams.origin !== undefined
      ? await checkedWorkerOrigin(startParams.origin, ctx)
      : undefined
  const prepared = await prepareWorkerStart(
    checked ? { ...startParams, origin: checked.origin } : startParams,
    ctx,
    startFollowUp
  )
  const {
    params,
    workTarget,
    followUp,
    coordinator,
    bindRun,
    helperCreator,
    taskDeps,
    existingTask,
    withRun
  } = prepared
  const db = runtime.getOrchestrationDb()
  const questionLink =
    params.forQuestion !== undefined
      ? linkWorkerToQuestion(db, params.forQuestion, coordinator, params.on !== undefined)
      : undefined
  const linkedParams =
    questionLink && !questionLink.linked ? { ...params, forQuestion: undefined } : params
  const reminder =
    params.forQuestion === undefined ? openQuestionReminder(db, coordinator) : undefined
  const withLink = <T>(started: T): T =>
    withOpenQuestion(reminder, withQuestionLink(questionLink, started))
  const { mode, chatLineage } = decideStartMode(runtime, db, params, orchestrationCaller, followUp)
  if (params.on) {
    // Remote workers are terminal-only; carry the mode receipt to explain structured-preference fallback.
    const receipt = await startFederatedWorker({
      params: linkedParams,
      runtime,
      db,
      bindRunId: () => bindRun().run.id,
      task: existingTask,
      taskDeps,
      orchestrationMutation,
      callerSession: orchestrationCaller,
      ...(workTarget ? { workTarget } : {})
    })
    await stopHelperAfterStart(runtime, receipt, orchestrationMutation)
    const placed = receipt && typeof receipt === 'object' ? { ...receipt, mode } : receipt
    return withLink(withRun(withKeepOpenDefault(runtime, params.worktree, placed)))
  }
  const receipt = await startLocalWorker({
    params: {
      ...linkedParams,
      timeoutMs: resolveWorkerStartReadinessTimeoutMs(params.timeoutMs)
    },
    runtime,
    db,
    bindRun: () => bindRun().run,
    taskDeps,
    coordinator,
    callerSession: orchestrationCaller,
    existingTask,
    orchestrationMutation,
    mode,
    chatLineage,
    helperCreator,
    followUp,
    ...(workTarget ? { workTarget } : {})
  })
  await stopHelperAfterStart(runtime, receipt, orchestrationMutation)
  const note = { itemUid: checked?.itemUid, chatLineage, terminal: params.terminal }
  void noteTerminalFallbackOnItem(runtime, note, receipt).catch(warnItemNote)
  const next = withKeepOpenDefault(runtime, params.worktree, withWorkerStartNext(receipt))
  const started = withLink(withRun(next))
  return checked && started && typeof started === 'object'
    ? { ...started, linkedItem: checked.linkedItem }
    : started
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
  if (!isWorkerStartTimeoutWithinTimerLimit(params.timeoutMs)) {
    throw new OrchestrationError(
      'invalid_argument',
      '--timeout-ms is too large for worker-start transport grace; the derived timeout must fit within the timer limit.'
    )
  }
  const db = runtime.getOrchestrationDb()
  let workTarget: ResolvedBotWorkTargetPlacement | undefined
  if (followUp) {
    workTarget = await resolveVerifiedFollowUpWorkTarget(runtime, db, orchestrationCaller, followUp)
  } else {
    const resolvedWorkTarget = resolveBotTurnWorkTargetForCaller(
      params,
      runtime.botWorkTargets,
      orchestrationCaller,
      false
    )
    params = resolvedWorkTarget.params
    workTarget = resolvedWorkTarget.enforcement
  }
  assertWorkerStartPlacementBoundaries(params, orchestrationCaller, followUp)
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
    workTarget,
    followUp,
    coordinator,
    bindRun,
    helperCreator,
    taskDeps,
    existingTask,
    withRun
  }
}

function warnItemNote(error: unknown): void {
  console.warn('[orchestration] item fallback note failed', error)
}
