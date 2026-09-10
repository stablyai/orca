import { z } from 'zod'
import { contextOnlyAbandonWarning } from '../../../../orchestration/context-only-dispatch-release'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { defineMethod, type RpcMethod } from '../../../core'
import { requiredString } from '../../../schemas'
import {
  exposeDispatchContext,
  exposeObservation,
  exposeWorker,
  inspectWorkerTerminal,
  projectFleetWorker,
  showContextOnlyWorker
} from './worker-observation'
import { exposeWorkerTerminalResource } from './worker-release-completion'
import { showFederatedWorker } from '../federation/federated-worker-show'

import { WORKER_READ_METHOD } from '../../orchestration-worker-read-method'
import { releaseStructuredWorkerSession } from '../../orchestration-structured-worker-session'
const WorkerDispatchParams = z.object({
  dispatch: requiredString('Missing --dispatch'),
  run: z.string().min(1).optional()
})

export const ORCHESTRATION_WORKER_CONTROL_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.workerShow',
    params: WorkerDispatchParams,
    handler: async (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const dispatch = db.getDispatchContextById(params.dispatch)
      let worker = db.getWorkerDispatch(params.dispatch)
      if (!dispatch) {
        throw new OrchestrationError(
          'dispatch_not_found',
          `Worker Dispatch ${params.dispatch} was not found.`
        )
      }
      if (params.run && dispatch.run_id !== params.run) {
        throw new OrchestrationError(
          'request_mismatch',
          `Worker Dispatch ${params.dispatch} belongs to Run ${dispatch.run_id}, not requested Run ${params.run}.`,
          { dispatchId: params.dispatch, expectedRunId: params.run, observedRunId: dispatch.run_id }
        )
      }
      const federated = db.getFederatedDispatch(params.dispatch)
      if (federated) {
        return showFederatedWorker({
          runtime,
          db,
          dispatchId: params.dispatch,
          dispatch,
          federated
        })
      }
      if (!worker) {
        return showContextOnlyWorker(runtime, db, dispatch)
      }
      if (worker.runtime_epoch && worker.runtime_epoch !== runtime.getRuntimeId()) {
        if (worker.state === 'starting') {
          worker = db.markWorkerStartUnknown(
            params.dispatch,
            worker.stage,
            'The runtime restarted before worker-start reached a terminal receipt.'
          )
        } else if (worker.state === 'stopping') {
          worker = db.markWorkerStopUnknown(
            params.dispatch,
            'The runtime restarted before worker-stop reached a terminal receipt.'
          )
        }
      }
      const observation = await inspectWorkerTerminal(runtime, db, params.dispatch)
      const resource = db.getWorkerTerminalResourceByOwner(params.dispatch)
      return {
        dispatch: exposeDispatchContext(dispatch),
        worker: exposeWorker(worker),
        // Why: the fleet verdict, so worker-show and worker-list cannot disagree.
        projection: projectFleetWorker(runtime, db, params.dispatch),
        terminal: observation.exact ? observation.terminal : null,
        observation: exposeObservation(observation),
        terminalResource: resource ? exposeWorkerTerminalResource(resource) : null
      }
    }
  }),
  WORKER_READ_METHOD,
  defineMethod({
    name: 'orchestration.workerAbandon',
    params: WorkerDispatchParams,
    handler: (params, { runtime }) => {
      const abandoned = runtime.getOrchestrationDb().abandonWorkerDispatch(params.dispatch)
      if (abandoned.disposition === 'context_only') {
        if (!abandoned.alreadySettled) {
          releaseStructuredWorkerSession(params.dispatch, runtime)
          runtime.notifyMessageArrived(`dispatch:${params.dispatch}`, 'status')
        }
        return {
          dispatchId: params.dispatch,
          state: abandoned.state,
          alreadySettled: abandoned.alreadySettled,
          stale: !abandoned.releasedCurrentTask,
          processAction: 'none',
          warning: contextOnlyAbandonWarning(abandoned),
          residualResources: []
        }
      }
      const worker = abandoned.worker
      if (abandoned.disposition === 'abandoned') {
        releaseStructuredWorkerSession(params.dispatch, runtime)
        runtime.notifyMessageArrived(`dispatch:${params.dispatch}`, 'status')
      }
      return {
        dispatchId: params.dispatch,
        state: worker.state,
        alreadySettled: abandoned.disposition !== 'abandoned',
        stale: abandoned.disposition === 'stale',
        processAction: 'none',
        warning:
          abandoned.disposition === 'stale'
            ? 'The Dispatch is no longer current; no state or process changed.'
            : 'Possibly-live resources were retained; no process was stopped or deleted.',
        residualResources: JSON.parse(worker.residual_resources) as unknown[]
      }
    }
  })
]
