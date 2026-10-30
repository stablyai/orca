import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { defineMethod } from '../../../core'
import {
  releaseFederatedWorker,
  retainFederatedWorker
} from '../federation/federated-worker-release'
import { ORCHESTRATION_WORKER_LIST_METHOD } from './worker-list-method'
import { resolvePinnedFederatedServer } from './worker-observation'
import { archiveSummary, exposeWorkerRetainReceipt } from './worker-terminal-resource-presentation'
import {
  completeWorkerTerminalRelease,
  type WorkerReleaseReceipt
} from './worker-release-completion'
import {
  WorkerDispatchParams,
  WorkerRetainParams
} from '../../../../../../shared/rpc-contract/orchestration-worker-release-schemas-params'
import { ORCHESTRATION_WORKER_KEEP_OPEN_METHODS } from './worker-keep-open'

export const ORCHESTRATION_WORKER_RELEASE_METHODS = [
  defineMethod({
    name: 'orchestration.workerRelease',
    permission: 'workspace',
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
        db.endFederatedHomeAutoRelease(params.dispatch)
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
    permission: 'workspace',
    params: WorkerRetainParams,
    handler: async (params, { runtime, orchestrationMutation }): Promise<WorkerReleaseReceipt> => {
      const db = runtime.getOrchestrationDb()
      const federated = db.getFederatedDispatch(params.dispatch)
      if (federated) {
        if (!orchestrationMutation) {
          throw new OrchestrationError(
            'invalid_argument',
            'Remote worker-retain requires a durable retry request.'
          )
        }
        db.endFederatedHomeAutoRelease(params.dispatch)
        const forwarded = await retainFederatedWorker({
          runtime,
          server: resolvePinnedFederatedServer(runtime, federated),
          federated,
          dispatchId: params.dispatch,
          requestId: orchestrationMutation.requestId
        })
        if (forwarded) {
          return forwarded
        }
      }
      return exposeWorkerRetainReceipt(
        params.dispatch,
        db.getRemoteDispatchAttachment(params.dispatch)
          ? db.retainRemoteAttachmentTerminalResource(params.dispatch)
          : db.retainWorkerTerminalResource(params.dispatch)
      )
    }
  }),
  ORCHESTRATION_WORKER_LIST_METHOD,
  ...ORCHESTRATION_WORKER_KEEP_OPEN_METHODS
]
