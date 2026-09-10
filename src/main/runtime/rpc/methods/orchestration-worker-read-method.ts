import { z } from 'zod'
import { ORCHESTRATION_WORKER_READ_SOURCES } from '../../../../shared/orchestration-worker-output'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalFiniteNumber, requiredString } from '../schemas'
import {
  inspectWorkerTerminal,
  projectFleetWorker,
  resolvePinnedFederatedServer
} from './orchestration/worker/worker-observation'
import { readArchivedWorkerOutput } from './orchestration/worker/worker-archive-read'
import { readExactWorkerOutput } from './orchestration/worker/worker-output'
import { readFederatedWorkerOutput } from './orchestration/federation/federated-worker-read'

const WorkerReadParams = z.object({
  dispatch: requiredString('Missing --dispatch'),
  cursor: z.union([z.number().int().nonnegative(), z.string().min(1).max(2_048)]).optional(),
  limit: OptionalFiniteNumber,
  source: z.enum(ORCHESTRATION_WORKER_READ_SOURCES).optional()
})

/** Reads exactly the requested Dispatch's output, refusing any identity change mid-read. */
export const WORKER_READ_METHOD: RpcMethod = defineMethod({
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
      const observed =
        resource.release_state === 'releasing'
          ? await inspectWorkerTerminal(runtime, db, params.dispatch)
          : null
      const archived = await readArchivedWorkerOutput({
        db,
        dispatchId: params.dispatch,
        workerState: worker?.state ?? 'unsupervised',
        resource,
        liveness:
          observed?.exact && (observed.status === 'live' || observed.status === 'exited')
            ? observed.status
            : undefined,
        source: params.source,
        cursor: params.cursor,
        limit: params.limit
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
    return { ...output, projection: projectFleetWorker(runtime, db, params.dispatch) }
  }
})
