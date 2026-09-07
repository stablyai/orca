import { z } from 'zod'
import { ORCHESTRATION_WORKER_READ_SOURCES } from '../../../../../../shared/orchestration-worker-output'
import { contextOnlyAbandonWarning } from '../../../../orchestration/context-only-dispatch-release'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { defineMethod, type RpcMethod } from '../../../core'
import { OptionalFiniteNumber, requiredString } from '../../../schemas'
import {
  exposeDispatchContext,
  exposeObservation,
  exposeWorker,
  inspectWorkerTerminal,
  projectFleetWorker,
  resolvePinnedFederatedServer,
  showContextOnlyWorker
} from './worker-observation'
import { readArchivedWorkerOutput } from './worker-archive-read'
import { readExactWorkerOutput } from './worker-output'
import { exposeWorkerTerminalResource } from './worker-release-completion'
import { readFederatedWorkerOutput } from '../federation/federated-worker-read'
import { showFederatedWorker } from '../federation/federated-worker-show'
const WorkerDispatchParams = z.object({ dispatch: requiredString('Missing --dispatch') })
const WorkerReadParams = WorkerDispatchParams.extend({
  cursor: z.union([z.number().int().nonnegative(), z.string().min(1).max(2_048)]).optional(),
  limit: OptionalFiniteNumber,
  source: z.enum(ORCHESTRATION_WORKER_READ_SOURCES).optional()
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
  defineMethod({
    name: 'orchestration.workerRead',
    params: WorkerReadParams,
    handler: async (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const federated = db.getFederatedDispatch(params.dispatch)
      if (federated) {
        const server = resolvePinnedFederatedServer(runtime, federated)
        return readFederatedWorkerOutput({
          runtime,
          db,
          server,
          federated,
          dispatchId: params.dispatch,
          source: params.source,
          cursor: params.cursor,
          limit: params.limit
        })
      }
      const dispatch = db.getDispatchContextById(params.dispatch)
      const worker = db.getWorkerDispatch(params.dispatch)
      const terminalHandle = worker?.agent_terminal_handle ?? dispatch?.assignee_handle
      if (!dispatch) {
        throw new OrchestrationError(
          'dispatch_not_found',
          `Dispatch ${params.dispatch} was not found.`
        )
      }
      if (!terminalHandle) {
        throw new OrchestrationError(
          'dispatch_not_found',
          `Worker Dispatch ${params.dispatch} has no agent terminal.`
        )
      }
      const resource = db.getWorkerTerminalResourceByOwner(params.dispatch)
      if (resource && ['releasing', 'unknown', 'released'].includes(resource.release_state)) {
        // Archive capture is not close evidence; recheck the execution host while releasing.
        let liveness: 'live' | 'unverifiable' | 'exited' =
          resource.release_state === 'released' ? 'exited' : 'unverifiable'
        if (resource.release_state === 'releasing') {
          const observed = await inspectWorkerTerminal(runtime, db, params.dispatch)
          liveness =
            observed.status === 'live'
              ? 'live'
              : observed.status === 'exited'
                ? 'exited'
                : 'unverifiable'
        }
        const archived = await readArchivedWorkerOutput({
          db,
          dispatchId: params.dispatch,
          workerState: worker?.state ?? 'unsupervised',
          resource,
          source: params.source,
          cursor: params.cursor,
          limit: params.limit,
          liveness
        })
        return { ...archived, projection: projectFleetWorker(runtime, db, params.dispatch) }
      }
      const observation = await inspectWorkerTerminal(runtime, db, params.dispatch)
      if (!observation.exact) {
        throw new OrchestrationError(
          'worker_identity_changed',
          `Worker Dispatch ${params.dispatch} no longer resolves to its exact process.`
        )
      }
      const output = await readExactWorkerOutput({
        runtime,
        dispatchId: params.dispatch,
        terminalHandle,
        workerState: worker?.state ?? 'unsupervised',
        terminalStatus:
          observation.status === 'exited'
            ? 'exited'
            : observation.status === 'unverifiable'
              ? 'unknown'
              : 'running',
        terminalLiveness:
          observation.status === 'unverifiable'
            ? 'unverifiable'
            : observation.status === 'exited'
              ? 'exited'
              : 'live',
        attachedAt: worker?.created_at ?? dispatch.dispatched_at ?? dispatch.created_at,
        source: params.source,
        cursor: params.cursor,
        limit: params.limit
      })
      const afterRead = await inspectWorkerTerminal(runtime, db, params.dispatch)
      if (!afterRead.exact) {
        throw new OrchestrationError(
          'worker_identity_changed',
          `Worker Dispatch ${params.dispatch} changed process while output was read.`
        )
      }
      // Two verdicts: status.liveness is the PTY's, the projection is the agent's.
      return { ...output, projection: projectFleetWorker(runtime, db, params.dispatch) }
    }
  }),
  defineMethod({
    name: 'orchestration.workerAbandon',
    params: WorkerDispatchParams,
    handler: (params, { runtime }) => {
      const abandoned = runtime.getOrchestrationDb().abandonWorkerDispatch(params.dispatch)
      if (abandoned.disposition === 'context_only') {
        if (!abandoned.alreadySettled) {
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
