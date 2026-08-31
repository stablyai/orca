import { z } from 'zod'
import type { WorkerTerminalListState } from '../../orchestration/worker-terminal-ownership'
import { defineMethod, type RpcMethod } from '../core'
import { requiredString } from '../schemas'
import {
  archiveSummary,
  completeWorkerTerminalRelease,
  exposeWorkerTerminalResource,
  type WorkerReleaseReceipt
} from './orchestration-worker-release-completion'
import { sweepSettledWorkerResumeFences } from './settled-worker-resume-fence-sweep'

const WorkerDispatchParams = z.object({ dispatch: requiredString('Missing --dispatch') })

const WORKER_TERMINAL_LIST_STATES = [
  'active',
  'reclaimable',
  'retained',
  'release_pending',
  'release_unknown',
  'released'
] as const

const WorkerListParams = z.object({
  run: z.string().min(1).optional(),
  terminalState: z.enum(WORKER_TERMINAL_LIST_STATES).optional()
})

// Why: release and retain both drop the worker's row from the legacy recovery plan, and
// `startFreshSpawn` refuses a fenced pane — so the sweep has to run in the same call or the fence
// outlives its dispatch and the pane cannot spawn until the next app start. Wrapping by name keeps
// every early return covered; workerList is a pure read and is deliberately absent.
const FENCE_SWEEPING_METHOD_NAMES = new Set([
  'orchestration.workerRelease',
  'orchestration.workerRetain'
])

function sweepingRetiredWorkerResumeFences(method: RpcMethod): RpcMethod {
  if (!FENCE_SWEEPING_METHOD_NAMES.has(method.name)) {
    return method
  }
  return {
    ...method,
    handler: async (params, ctx) => {
      const result = await method.handler(params, ctx)
      sweepSettledWorkerResumeFences(ctx.runtime)
      return result
    }
  }
}

const WORKER_RELEASE_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.workerRelease',
    params: WorkerDispatchParams,
    handler: async (params, { runtime }): Promise<WorkerReleaseReceipt> => {
      const db = runtime.getOrchestrationDb()
      if (db.getFederatedDispatch(params.dispatch)) {
        // Fail closed: the worker server owns that terminal; a home-side close would be a guess.
        return {
          dispatchId: params.dispatch,
          state: 'retained',
          reason: 'federation_unsupported',
          processAction: 'none',
          archive: null,
          recovery:
            'Connected-server workers do not support release yet; inspect the worker server directly.'
        }
      }
      const requested = db.requestWorkerTerminalRelease(params.dispatch)
      if (requested.disposition === 'already_released') {
        return {
          dispatchId: params.dispatch,
          state: 'already_released',
          processAction: 'none',
          archive: archiveSummary(requested.resource)
        }
      }
      if (requested.disposition === 'retained') {
        const resource = requested.resource
        const processIncarnation = resource?.process_incarnation
        if (
          processIncarnation &&
          (await runtime.inspectTerminalProcessIncarnationLiveness(
            processIncarnation,
            resource.host_scope
          )) === 'exited'
        ) {
          const reconciled = db.settleDeadWorkerTerminalRelease({
            requestingDispatchId: params.dispatch,
            resourceId: resource.id,
            processIncarnation
          })
          if (reconciled.disposition === 'released') {
            runtime.notifyMessageArrived(`dispatch:${params.dispatch}`, 'status')
            return {
              dispatchId: params.dispatch,
              state: 'released',
              processAction: 'none',
              archive: archiveSummary(reconciled.resource)
            }
          }
        }
        return {
          dispatchId: params.dispatch,
          state: 'retained',
          reason: requested.reason,
          processAction: 'none',
          archive: archiveSummary(resource)
        }
      }
      return completeWorkerTerminalRelease({
        runtime,
        db,
        dispatchId: params.dispatch,
        resource: requested.resource
      })
    }
  }),
  defineMethod({
    name: 'orchestration.workerRetain',
    params: WorkerDispatchParams,
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const retained = db.retainWorkerTerminalResource(params.dispatch)
      if (retained.disposition === 'already_released') {
        return {
          dispatchId: params.dispatch,
          state: 'already_released' as const,
          processAction: 'none' as const,
          archive: archiveSummary(retained.resource)
        }
      }
      if (retained.disposition === 'no_owned_resource') {
        return {
          dispatchId: params.dispatch,
          state: 'retained' as const,
          reason: 'no_owned_resource' as const,
          processAction: 'none' as const,
          archive: null
        }
      }
      if (retained.disposition === 'release_committed') {
        const unknown = retained.resource.release_state === 'unknown'
        return {
          dispatchId: params.dispatch,
          state: unknown ? ('release_unknown' as const) : ('release_pending' as const),
          processAction: 'none' as const,
          archive: archiveSummary(retained.resource),
          ...(retained.resource.release_error
            ? { lastError: retained.resource.release_error }
            : {}),
          recovery:
            'Terminal release was already committed and could not be changed to retained; inspect worker-show before taking further action.'
        }
      }
      return {
        dispatchId: params.dispatch,
        state: 'retained' as const,
        reason: 'user_requested' as const,
        processAction: 'none' as const,
        archive: archiveSummary(retained.resource)
      }
    }
  }),
  defineMethod({
    name: 'orchestration.workerList',
    params: WorkerListParams,
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const rows = db.listWorkerTerminalResources({ runId: params.run })
      const workers = rows
        .filter((row) => !params.terminalState || row.terminalState === params.terminalState)
        .map((row) => ({
          dispatchId: row.dispatchId,
          taskId: row.taskId,
          runId: row.runId,
          workerState: row.workerState,
          dispatchStatus: row.dispatchStatus,
          agentTerminalHandle: row.agentTerminalHandle,
          terminalState: row.terminalState,
          resource: row.resource ? exposeWorkerTerminalResource(row.resource) : null
        }))
      const counts: Partial<Record<WorkerTerminalListState, number>> = {}
      for (const row of rows) {
        if (row.terminalState) {
          counts[row.terminalState] = (counts[row.terminalState] ?? 0) + 1
        }
      }
      return { workers, counts }
    }
  }),
  defineMethod({
    name: 'orchestration.workerTerminalUserInput',
    params: z.object({ paneKey: requiredString('Missing paneKey') }),
    // Real user keystrokes durably relinquish orchestration ownership on the owning runtime, so
    // restarts, SSH drops, remote viewing, and renderer remounts cannot erase the takeover.
    handler: (params, { runtime }) => {
      const changed = runtime.getOrchestrationDb().markWorkerTerminalUserOwned(params.paneKey)
      if (changed > 0) {
        // Why: only a real takeover retires the resource; ordinary panes report here too and must
        // not pay for a plan read on every 30s keystroke window.
        sweepSettledWorkerResumeFences(runtime)
      }
      return { changed }
    }
  })
]

export const ORCHESTRATION_WORKER_RELEASE_METHODS: RpcMethod[] = WORKER_RELEASE_METHODS.map(
  sweepingRetiredWorkerResumeFences
)
