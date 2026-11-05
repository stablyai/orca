import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { defineMethod } from '../../../core'
import { mapWithConcurrency } from '../../../../../../shared/map-with-concurrency'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'
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
      const state = db.getWorkerDispatch(dispatchId)?.state
      if (state === 'starting') {
        stopsAfterStart(runtime).add(dispatchId)
        return [{ ...helper, outcome: 'starting', state }]
      }
      try {
        const receipt = await stopWorkerAndHelpers(
          runtime,
          dispatchId,
          helperMutation(mutation, dispatchId)
        )
        const outcome = receipt.alreadySettled
          ? 'already_finished'
          : receipt.state === 'stopped'
            ? 'stopped'
            : 'unconfirmed'
        return [
          {
            ...helper,
            outcome,
            state: receipt.state,
            ...(receipt.lastError ? { lastError: receipt.lastError } : {})
          },
          ...(receipt.helpers ?? [])
        ]
      } catch (error) {
        if (error instanceof OrchestrationError && error.code === 'terminal_kept_open') {
          // The user keeps this helper, so the helpers working for it keep running too.
          return [{ ...helper, outcome: 'kept_open', state }, ...listUnderKeptOpen(db, dispatchId)]
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

function listUnderKeptOpen(db: OrchestrationDb, creatorDispatchId: string): HelperStopOutcome[] {
  return db.listHelperDispatchIds(creatorDispatchId).flatMap((dispatchId) => [
    {
      dispatchId,
      creatorDispatchId,
      outcome: 'under_kept_open' as const,
      state: db.getWorkerDispatch(dispatchId)?.state
    },
    ...listUnderKeptOpen(db, dispatchId)
  ])
}

function helperMutation(mutation: StopMutation, dispatchId: string): StopMutation {
  return mutation && { ...mutation, requestId: `${mutation.requestId}:${dispatchId}` }
}

const stopsAfterStartByRuntime = new WeakMap<OrcaRuntimeService, Set<string>>()

/** Helpers a creator's stop found still starting; their start's end stops them. */
function stopsAfterStart(runtime: OrcaRuntimeService): Set<string> {
  let pending = stopsAfterStartByRuntime.get(runtime)
  if (!pending) {
    pending = new Set()
    stopsAfterStartByRuntime.set(runtime, pending)
  }
  return pending
}

/** Stops a helper whose creator's stop found it starting, once that start ends with an agent that may run. */
export async function stopHelperAfterStart(
  runtime: OrcaRuntimeService,
  startReceipt: unknown,
  mutation: StopMutation
): Promise<void> {
  const dispatchId =
    startReceipt && typeof startReceipt === 'object' && 'dispatchId' in startReceipt
      ? startReceipt.dispatchId
      : undefined
  if (typeof dispatchId !== 'string' || !stopsAfterStart(runtime).delete(dispatchId)) {
    return
  }
  const state = runtime.getOrchestrationDb().getWorkerDispatch(dispatchId)?.state
  if (state === 'ready' || state === 'start_unknown') {
    await stopWorkerAndHelpers(runtime, dispatchId, helperMutation(mutation, dispatchId)).catch(
      (error: unknown) => {
        console.warn('[orchestration] helper stop after its start failed', dispatchId, error)
      }
    )
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
