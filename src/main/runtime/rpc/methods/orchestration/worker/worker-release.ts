import { z } from 'zod'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { defineMethod, type RpcMethod } from '../../../core'
import { releaseFederatedWorker } from '../federation/federated-worker-release'
import { ORCHESTRATION_WORKER_LIST_METHOD } from './worker-list-method'
import { resolvePinnedFederatedServer } from './worker-observation'
import {
  archiveSummary,
  completeWorkerTerminalRelease,
  type WorkerReleaseReceipt
} from './worker-release-completion'
import { WorkerDispatchParams, WorkerRetainParams } from './worker-release-schemas'

export const ORCHESTRATION_WORKER_RELEASE_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.workerRelease',
    params: WorkerDispatchParams,
    handler: async (params, { runtime, orchestrationMutation }): Promise<WorkerReleaseReceipt> => {
      const db = runtime.getOrchestrationDb()
      const federated = db.getFederatedDispatch(params.dispatch)
      if (federated) {
        if (!orchestrationMutation) {
          throw new OrchestrationError(
            'invalid_argument',
            'Remote worker-release requires a durable retry request.'
          )
        }
        return releaseFederatedWorker({
          runtime,
          server: resolvePinnedFederatedServer(runtime, federated),
          federated,
          dispatchId: params.dispatch,
          requestId: orchestrationMutation.requestId
        })
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
    params: WorkerRetainParams,
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
  ORCHESTRATION_WORKER_LIST_METHOD,
  defineMethod({
    name: 'orchestration.workerTerminalUserInput',
    // `sessionId` addresses a worker that IS a structured agent session. Its pane key is a random
    // identity credential that never leaves main, so the caller names the session and the owning
    // runtime resolves it — a renderer echoing the pane key back would make it learnable.
    params: z
      .object({ paneKey: z.string().min(1).optional(), sessionId: z.string().min(1).optional() })
      .refine((value) => Boolean(value.paneKey ?? value.sessionId), 'Missing paneKey or sessionId'),
    // Real user keystrokes durably relinquish orchestration ownership on the owning runtime, so
    // restarts, SSH drops, remote viewing, and renderer remounts cannot erase the takeover.
    handler: (params, { runtime }) => {
      // A structured worker reports by session id; it has no pane of its own to name.
      const paneKey =
        params.paneKey ?? runtime.getStructuredWorkerPaneKeyForSession(params.sessionId!)
      const changed = paneKey
        ? runtime.getOrchestrationDb().markWorkerTerminalUserOwned(paneKey)
        : 0
      return { changed }
    }
  })
]
