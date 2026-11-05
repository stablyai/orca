import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { defineMethod } from '../../../core'
import { mapWithConcurrency } from '../../../../../../shared/map-with-concurrency'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { WorkerDispatchParams } from '../../../../../../shared/rpc-contract/orchestration-worker-stop-params'
import {
  stopSingleWorker,
  type HelperStopOutcome,
  type StopMutation,
  type WorkerStopReceipt
} from './single-worker-stop'

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
        return [{ ...helper, outcome: 'starting', state }]
      }
      try {
        const receipt = await stopWorkerAndHelpers(
          runtime,
          dispatchId,
          mutation && { ...mutation, requestId: `${mutation.requestId}:${dispatchId}` }
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
          return [{ ...helper, outcome: 'kept_open', state }]
        }
        return [
          {
            ...helper,
            outcome: 'unconfirmed',
            state,
            lastError: error instanceof Error ? error.message : String(error)
          }
        ]
      }
    }
  )
  return outcomes.flat()
}

/** A helper whose start finished after its creator was stopped; the creator's stop saw it starting. */
export async function stopHelperOfStoppedCreator(
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
  if (
    creator &&
    db.isWorkerStopRequested(creator) &&
    db.getWorkerDispatch(dispatchId)?.state === 'ready'
  ) {
    await stopWorkerAndHelpers(
      runtime,
      dispatchId,
      mutation && { ...mutation, requestId: `${mutation.requestId}:${dispatchId}` }
    ).catch((error: unknown) => {
      console.warn('[orchestration] helper stop after creator stop failed', dispatchId, error)
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
