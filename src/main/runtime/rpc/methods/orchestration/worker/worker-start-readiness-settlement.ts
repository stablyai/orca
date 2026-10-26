import {
  AGENT_PROMPT_EFFECT_TIMEOUT_MS,
  ORCHESTRATION_WORKER_START_CLIENT_GRACE_MS
} from '../../../../../../shared/orchestration-timing-budgets'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'
import type { RunRow, TaskRow } from '../../../../orchestration/types'
import type { WorkerStartModeReceipt } from '../../orchestration-worker-start-mode'
import { deliverWorkerDispatchPreamble } from './deliver-worker-dispatch-preamble'
import { chatAssigneeSessionId } from '../../../../orchestration/chat-assignee'
import type { OrchestrationWorkerLaunchReceipt } from './worker-launch-preferences'
import {
  describeUnobservedWorkerTurnStart,
  observeWorkerTurnStart,
  type WorkerTurnStartObservation
} from './worker-start-turn-observation'
import {
  monitorWorkerSetup,
  type createStructuredWorkerSessionForWorktree,
  type WorkerEffect,
  type WorkerSetupReceipt
} from './worker-topology'

/** Claim ready only for proven turn start or unsupported observation; supported-but-unobserved starts remain start_unknown. */
export async function deliverAndSettleWorkerStartReadiness(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  run: RunRow
  task: TaskRow
  dispatchId: string
  dispatchDepth: number
  structuredSession: Awaited<ReturnType<typeof createStructuredWorkerSessionForWorktree>> | null
  terminalHandle: string
  coordinatorHandle: string
  devMode: boolean | undefined
  requestId: string
  agent: string | null
  /** The agent this start launched into `terminalHandle`; null when the caller supplied it. */
  launchedAgent: string | null
  setupReceipt: WorkerSetupReceipt
  launchReceipt: OrchestrationWorkerLaunchReceipt
  mode: WorkerStartModeReceipt
  /** The caller's timeout, as the receipt reports it. */
  timeoutMs: number
  /** When the caller's timeout runs out; a structured preamble waits on its agent until then. */
  readinessDeadline: number
  effects: WorkerEffect[]
  terminalRevealWarning: string | undefined
  /** Keeps the caller's failure receipt naming the stage that actually failed. */
  onStage: (stage: 'dispatch_input' | 'turn_observation') => void
}): Promise<unknown> {
  const { runtime, db, run, task, structuredSession, terminalHandle, effects } = args

  args.onStage('dispatch_input')
  const deliveryStartedAt = Date.now()
  const delivery = await deliverWorkerDispatchPreamble({
    runtime,
    db,
    structuredSession,
    terminalHandle,
    dispatchId: args.dispatchId,
    dispatchDepth: args.dispatchDepth,
    runId: run.id,
    taskId: task.id,
    taskSpec: task.spec,
    coordinatorHandle: args.coordinatorHandle,
    devMode: args.devMode,
    requestId: args.requestId,
    launchedAgent: args.launchedAgent,
    readinessTimeoutMs: Math.max(0, args.readinessDeadline - Date.now())
  })
  effects.push({
    kind: 'dispatch_input',
    role: 'agent',
    id: terminalHandle,
    state: 'accepted'
  })

  args.onStage('turn_observation')
  // Accepted writes need positive turn-start evidence when supported; structured sends prove acceptance or remain held.
  const promptDelivery = delivery.prompt
  const turnStart: WorkerTurnStartObservation =
    delivery.structuredTurnStart ??
    (await observeWorkerTurnStart({
      runtime,
      terminalHandle,
      prompt: promptDelivery,
      // Why: a delivery that waited out a held Windows paste must still fit the client's grace.
      timeoutMs: Math.min(
        AGENT_PROMPT_EFFECT_TIMEOUT_MS,
        Math.max(0, ORCHESTRATION_WORKER_START_CLIENT_GRACE_MS - (Date.now() - deliveryStartedAt))
      )
    }))
  const deliveredPrompt = turnStart.prompt ?? promptDelivery
  monitorWorkerSetup({
    runtime,
    db,
    runId: run.id,
    dispatchId: args.dispatchId,
    setupReceipt: args.setupReceipt,
    effects
  })
  // A worker report can settle the dispatch while turn observation is outstanding.
  const currentWorker = db.getWorkerDispatch(args.dispatchId)
  const alreadySettled = currentWorker && currentWorker.state !== 'starting'
  if (turnStart.verdict === 'unobserved' && !alreadySettled) {
    // Keep authority and terminal for recovery reports, but never claim ready for an unobserved turn.
    effects.push({
      kind: 'dispatch_input',
      role: 'agent',
      id: terminalHandle,
      state: 'turn_unobserved'
    })
    const reason = turnStart.reason ?? describeUnobservedWorkerTurnStart(args.agent)
    const worker = db.markWorkerStartUnknown(
      args.dispatchId,
      'turn_start_unobserved',
      reason,
      effects
    )
    return {
      runId: run.id,
      taskId: task.id,
      dispatchId: args.dispatchId,
      state: 'outcome_unknown',
      stage: worker.stage,
      turnStart: turnStart.verdict,
      lastError: reason,
      setup: args.setupReceipt,
      launch: args.launchReceipt,
      mode: args.mode,
      timeoutMs: args.timeoutMs,
      effects,
      ...(deliveredPrompt ? { prompt: deliveredPrompt } : {}),
      residualResources: JSON.parse(worker.residual_resources) as unknown[],
      nextCommands: [
        `orca orchestration worker-show --dispatch ${args.dispatchId} --json`,
        // A structured worker or a chat has no screen to read.
        ...(structuredSession || chatAssigneeSessionId(terminalHandle)
          ? []
          : [`orca terminal read --terminal ${terminalHandle} --screen`]),
        `orca orchestration worker-abandon --dispatch ${args.dispatchId} --json`
      ],
      ...(args.terminalRevealWarning ? { warning: args.terminalRevealWarning } : {})
    }
  }
  const worker = alreadySettled
    ? currentWorker
    : db.markWorkerDispatchReady(args.dispatchId, effects)
  // A completed task proves start succeeded; older callers use only 'ready' as start success.
  const reportedOutcome =
    worker.stage === 'settled' && (worker.state === 'succeeded' || worker.state === 'failed')
      ? worker.state
      : undefined
  return {
    runId: run.id,
    taskId: task.id,
    dispatchId: args.dispatchId,
    state: reportedOutcome ? 'ready' : worker.state,
    stage: worker.stage,
    ...(reportedOutcome ? { workerOutcome: reportedOutcome } : {}),
    turnStart: turnStart.verdict,
    setup: args.setupReceipt,
    launch: args.launchReceipt,
    mode: args.mode,
    timeoutMs: args.timeoutMs,
    effects,
    ...(deliveredPrompt ? { prompt: deliveredPrompt } : {}),
    residualResources: [],
    ...(args.terminalRevealWarning ? { warning: args.terminalRevealWarning } : {})
  }
}
