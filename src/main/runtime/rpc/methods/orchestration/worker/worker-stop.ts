import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { defineMethod } from '../../../core'
import { mapWithConcurrency } from '../../../../../../shared/map-with-concurrency'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'
import { WORKER_SETTLED_STATES } from '../../../../orchestration/worker-terminal-ownership'
import { WorkerDispatchParams } from '../../../../../../shared/rpc-contract/orchestration-worker-stop-params'
import type {
  HelperStopOutcome,
  WorkerStopReceipt
} from '../../../../../../shared/orchestration-worker-stop-receipt'
import { stopSingleWorker, type StopMutation } from './single-worker-stop'

export const ORCHESTRATION_WORKER_STOP_METHODS = [
  defineMethod({
    name: 'orchestration.workerStop',
    permission: 'workspace',
    params: WorkerDispatchParams,
    handler: (params, { runtime, orchestrationMutation }) =>
      stopWorkerAndHelpers(runtime, params.dispatch, orchestrationMutation)
  })
]

/** Stopping a worker stops every helper under it; a kept-open helper is reported, not refused. */
export function stopWorkerAndHelpers(
  runtime: OrcaRuntimeService,
  dispatchId: string,
  mutation: StopMutation
): Promise<WorkerStopReceipt> {
  return dedupeWorkerStop(runtime, dispatchId, async () =>
    withStoppedHelpers(
      runtime,
      dispatchId,
      mutation,
      await stopSingleWorker(runtime, dispatchId, mutation)
    )
  )
}

/** Runs after the creator's fence commits, so a helper started later was refused, or is stopped when its start finishes. */
export async function withStoppedHelpers(
  runtime: OrcaRuntimeService,
  creatorDispatchId: string,
  mutation: StopMutation,
  receipt: WorkerStopReceipt
): Promise<WorkerStopReceipt> {
  const helpers = [
    ...(receipt.helpers ?? []),
    ...(await stopHelpers(runtime, creatorDispatchId, mutation))
  ]
  return helpers.length ? { ...receipt, helpers } : receipt
}

async function stopHelpers(
  runtime: OrcaRuntimeService,
  creatorDispatchId: string,
  mutation: StopMutation
): Promise<HelperStopOutcome[]> {
  const db = runtime.getOrchestrationDb()
  const outcomes = await mapWithConcurrency(
    db.listHelperDispatchIds(creatorDispatchId),
    8,
    async (dispatchId): Promise<HelperStopOutcome[]> => {
      const helper = { dispatchId, creatorDispatchId }
      const worker = db.getWorkerDispatch(dispatchId)
      if (worker?.state === 'starting' && worker.runtime_epoch !== runtime.getRuntimeId()) {
        // A runtime that restarted mid-start never finishes it; settle it as worker-show does, then stop it.
        db.markWorkerStartUnknown(
          dispatchId,
          worker.stage,
          'The runtime restarted before worker-start reached a terminal receipt.'
        )
      }
      const state = db.getWorkerDispatch(dispatchId)?.state
      if (state === 'starting') {
        return [
          { ...helper, outcome: 'starting', state },
          ...(await stopHelpers(runtime, dispatchId, mutation))
        ]
      }
      try {
        const receipt = await stopWorkerAndHelpers(
          runtime,
          dispatchId,
          helperMutation(mutation, dispatchId)
        )
        // A helper whose host could not stop its own helpers is not done, settled or not.
        const outcome = receipt.helperStopError
          ? 'unconfirmed'
          : receipt.alreadySettled
            ? 'already_finished'
            : receipt.state === 'stopped'
              ? 'stopped'
              : 'unconfirmed'
        const lastError = receipt.helperStopError ?? receipt.lastError
        return [
          { ...helper, outcome, state: receipt.state, ...(lastError ? { lastError } : {}) },
          ...(receipt.helpers ?? [])
        ]
      } catch (error) {
        if (error instanceof OrchestrationError && error.code === 'terminal_kept_open') {
          // The user keeps this helper, so the helpers working for it keep running too.
          return [
            { ...helper, outcome: 'kept_open', state },
            ...listUnderKeptOpen(db, dispatchId, dispatchId)
          ]
        }
        const lastError = error instanceof Error ? error.message : String(error)
        return [
          { ...helper, outcome: 'unconfirmed', state, lastError },
          ...(await stopHelpers(runtime, dispatchId, mutation))
        ]
      }
    }
  )
  return outcomes.flat()
}

function listUnderKeptOpen(
  db: OrchestrationDb,
  creatorDispatchId: string,
  keptOpenBy: string
): HelperStopOutcome[] {
  return db.listHelperDispatchIds(creatorDispatchId).flatMap((dispatchId) => {
    const state = db.getWorkerDispatch(dispatchId)?.state
    const finished = state !== undefined && WORKER_SETTLED_STATES.includes(state)
    return [
      finished
        ? { dispatchId, creatorDispatchId, outcome: 'already_finished' as const, state }
        : { dispatchId, creatorDispatchId, outcome: 'kept_open' as const, keptOpenBy, state },
      ...listUnderKeptOpen(db, dispatchId, keptOpenBy)
    ]
  })
}

function helperMutation(mutation: StopMutation, dispatchId: string): StopMutation {
  return mutation && { ...mutation, requestId: `${mutation.requestId}:${dispatchId}` }
}

/** Stops a helper whose start ended after worker-stop fenced its creator, which listed it as starting. */
export async function stopHelperAfterStart(
  runtime: OrcaRuntimeService,
  startReceipt: unknown,
  mutation: StopMutation
): Promise<void> {
  const dispatchId =
    startReceipt && typeof startReceipt === 'object' && 'dispatchId' in startReceipt
      ? startReceipt.dispatchId
      : undefined
  if (typeof dispatchId !== 'string') {
    return
  }
  const db = runtime.getOrchestrationDb()
  const creator = db.getDispatchContextById(dispatchId)?.creator_dispatch_id
  if (!creator || !db.isWorkerStopRequested(creator)) {
    return
  }
  // A start that already settled is skipped by the single stop; its helpers still stop.
  // Its creator's receipt already said "starting"; the outcome lands on the helper's own row and here.
  const receipt = await stopWorkerAndHelpers(
    runtime,
    dispatchId,
    helperMutation(mutation, dispatchId)
  ).catch((error: unknown) => {
    console.warn('[orchestration] helper stop after its start failed', dispatchId, error)
  })
  const unconfirmed = receipt?.helpers?.filter((helper) => helper.outcome === 'unconfirmed') ?? []
  if (
    receipt &&
    ((receipt.state !== 'stopped' && !receipt.alreadySettled) ||
      receipt.helperStopError ||
      unconfirmed.length)
  ) {
    console.warn('[orchestration] helper stop after its start is unconfirmed', {
      dispatchId,
      state: receipt.state,
      lastError: receipt.lastError,
      helperStopError: receipt.helperStopError,
      unconfirmed: unconfirmed.map((helper) => ({
        dispatchId: helper.dispatchId,
        lastError: helper.lastError
      }))
    })
  }
}

const activeStopByRuntime = new WeakMap<
  OrcaRuntimeService,
  Map<string, Promise<WorkerStopReceipt>>
>()

/** Coalesce same-runtime stops so only one closes; beginWorkerStop admits this epoch only to recover a row stranded by a dead runtime. */
function dedupeWorkerStop(
  runtime: OrcaRuntimeService,
  dispatchId: string,
  stop: () => Promise<WorkerStopReceipt>
): Promise<WorkerStopReceipt> {
  let active = activeStopByRuntime.get(runtime)
  if (!active) {
    active = new Map()
    activeStopByRuntime.set(runtime, active)
  }
  const inFlight = active.get(dispatchId)
  if (inFlight) {
    return inFlight
  }
  const started = stop().finally(() => {
    if (active.get(dispatchId) === started) {
      active.delete(dispatchId)
    }
  })
  active.set(dispatchId, started)
  return started
}
