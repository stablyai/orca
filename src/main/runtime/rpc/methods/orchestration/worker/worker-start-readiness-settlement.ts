import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'
import type { RunRow, TaskRow } from '../../../../orchestration/types'
import type { WorkerStartModeReceipt } from '../../orchestration-worker-start-mode'
import { deliverWorkerDispatchPreamble } from './deliver-worker-dispatch-preamble'
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

/**
 * Delivers the dispatch preamble and settles the worker's start state on the strongest
 * evidence available: `ready` only with a positive turn-start (or a provider that cannot
 * prove one), `start_unknown` when observation is supported and nothing started.
 */
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
  dispatchCapability: string
  devMode: boolean | undefined
  requestId: string
  agent: string | null
  setupReceipt: WorkerSetupReceipt
  launchReceipt: OrchestrationWorkerLaunchReceipt
  mode: WorkerStartModeReceipt
  timeoutMs: number
  effects: WorkerEffect[]
  terminalRevealWarning: string | undefined
  /** Keeps the caller's failure receipt naming the stage that actually failed. */
  onStage: (stage: 'dispatch_input' | 'turn_observation') => void
}): Promise<unknown> {
  const { runtime, db, run, task, structuredSession, terminalHandle, effects } = args

  args.onStage('dispatch_input')
  const promptDelivery = await deliverWorkerDispatchPreamble({
    runtime,
    structuredSession,
    terminalHandle,
    dispatchId: args.dispatchId,
    dispatchDepth: args.dispatchDepth,
    taskId: task.id,
    taskSpec: task.spec,
    coordinatorHandle: args.coordinatorHandle,
    dispatchCapability: args.dispatchCapability,
    devMode: args.devMode,
    requestId: args.requestId
  })
  effects.push({
    kind: 'dispatch_input',
    role: 'agent',
    id: terminalHandle,
    state: 'accepted'
  })

  args.onStage('turn_observation')
  // The write above was accepted without waiting on provider hooks; now demand the positive
  // evidence the receipt claims is observable. A worker whose turn never starts must not be
  // reported ready — a wedged agent and a working one looked identical before this gate.
  // A structured preamble send is acknowledged by the provider or throws, so it is already
  // positive evidence.
  const turnStart: WorkerTurnStartObservation = structuredSession
    ? { verdict: 'observed' }
    : await observeWorkerTurnStart({ runtime, terminalHandle, prompt: promptDelivery })
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
    // Honest `unverifiable`: keep the dispatch capability and the terminal — the worker may
    // still recover and report (worker-report settlement reconnects a start_unknown worker) —
    // but never claim ready for a turn nobody observed.
    effects.push({
      kind: 'dispatch_input',
      role: 'agent',
      id: terminalHandle,
      state: 'turn_unobserved'
    })
    const reason = describeUnobservedWorkerTurnStart(args.agent)
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
        `orca terminal read --terminal ${terminalHandle} --screen`,
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
