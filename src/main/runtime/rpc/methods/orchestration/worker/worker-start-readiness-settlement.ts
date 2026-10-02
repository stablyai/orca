import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'
import type { RunRow, TaskRow } from '../../../../orchestration/types'
import type { WorkerStartModeReceipt } from '../../orchestration-worker-start-mode'
import { deliverWorkerDispatchPreamble } from './deliver-worker-dispatch-preamble'
import { awaitDispatchPreambleTurnDelivered } from '../../../../orchestration/dispatch-preamble-turn'
import type { DispatchPreambleTurnRow } from '../../../../orchestration/db/dispatch-context/dispatch-preamble-turn-store'
import { AGENT_PROMPT_EFFECT_TIMEOUT_MS } from '../../../../../../shared/orchestration-timing-budgets'
import { isStructuredSessionAddress } from '../../../../structured-worker-identity'
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

const OBSERVATION_WINDOW = `during observation (up to ${Math.round(AGENT_PROMPT_EFFECT_TIMEOUT_MS / 1000)}s)`
const CHAT_PREAMBLE_OWED =
  `The dispatch preamble is owed to the chat as its next turn; it was not sent ${OBSERVATION_WINDOW}. ` +
  'It is sent when the chat can take a turn; if the worker then reports, this Dispatch settles ' +
  'normally.'
const CHAT_PREAMBLE_NOT_TAKEN =
  "The dispatch preamble was offered to the chat as a turn, and the chat's provider did not take " +
  `it ${OBSERVATION_WINDOW}; it is offered again later. If the worker then reports, this ` +
  'Dispatch settles normally.'
const CHAT_PREAMBLE_DISPATCH_ENDED =
  'The Dispatch ended during observation, so its dispatch preamble will not be sent.'
const CHAT_PREAMBLE_SENT_UNCONFIRMED =
  "The dispatch preamble was sent to the chat, but the chat's provider did not confirm it as a " +
  `turn ${OBSERVATION_WINDOW}; the chat may be working on it. If the worker reports, this ` +
  'Dispatch settles normally.'

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
  const delivery = await deliverWorkerDispatchPreamble({
    runtime,
    db,
    structuredSession,
    terminalHandle,
    dispatchId: args.dispatchId,
    dispatchDepth: args.dispatchDepth,
    taskId: task.id,
    taskSpec: task.spec,
    coordinatorHandle: args.coordinatorHandle,
    devMode: args.devMode,
    requestId: args.requestId
  })
  const promptDelivery = delivery.prompt
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
  // A structured preamble send is its own evidence: acknowledged, or still held for its agent.
  // A chat's preamble turn started once its provider accepted it, observed under a terminal's budget.
  const turnStart: WorkerTurnStartObservation =
    delivery.structuredTurnStart ??
    (delivery.chatPreambleTurn
      ? chatPreambleTurnStart(
          await awaitDispatchPreambleTurnDelivered(
            db,
            args.dispatchId,
            AGENT_PROMPT_EFFECT_TIMEOUT_MS
          )
        )
      : await observeWorkerTurnStart({ runtime, terminalHandle, prompt: promptDelivery }))
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
    // Honest `unverifiable`: keep lifecycle authority and the terminal — the worker may
    // still recover and report (worker-report settlement reconnects a start_unknown worker) —
    // but never claim ready for a turn nobody observed.
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
        // A structured session, a minted worker or a chat, has no screen to read.
        ...(structuredSession || isStructuredSessionAddress(terminalHandle)
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

/** A chat's preamble turn start, worded by how far its one send got. */
function chatPreambleTurnStart(
  row: DispatchPreambleTurnRow | undefined
): WorkerTurnStartObservation {
  if (row?.state === 'delivered') {
    return { verdict: 'observed' }
  }
  return { verdict: 'unobserved', reason: chatPreambleUnobservedReason(row) }
}

function chatPreambleUnobservedReason(row: DispatchPreambleTurnRow | undefined): string {
  if (!row) {
    return CHAT_PREAMBLE_DISPATCH_ENDED
  }
  if (row.state === 'sending' || row.state === 'in_doubt') {
    return CHAT_PREAMBLE_SENT_UNCONFIRMED
  }
  // Owed: an operation id on the row means a send was made and not taken (refused, or no session).
  return row.operation_id ? CHAT_PREAMBLE_NOT_TAKEN : CHAT_PREAMBLE_OWED
}
