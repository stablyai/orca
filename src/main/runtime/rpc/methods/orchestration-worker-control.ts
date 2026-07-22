import { z } from 'zod'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { syncFederatedDispatch } from '../../orchestration/federation-sync'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalFiniteNumber, requiredString } from '../schemas'
import {
  callFederatedWorkerShow,
  exposeWorker,
  inspectWorkerTerminal,
  resolvePinnedFederatedServer
} from './orchestration-worker-observation'

const WorkerDispatchParams = z.object({ dispatch: requiredString('Missing --dispatch') })
const WorkerReadParams = WorkerDispatchParams.extend({
  cursor: OptionalFiniteNumber,
  limit: OptionalFiniteNumber
})

export const ORCHESTRATION_WORKER_CONTROL_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.workerShow',
    params: WorkerDispatchParams,
    handler: async (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const dispatch = db.getDispatchContextById(params.dispatch)
      let worker = db.getWorkerDispatch(params.dispatch)
      if (!dispatch || !worker) {
        throw new OrchestrationError(
          'dispatch_not_found',
          `Worker Dispatch ${params.dispatch} was not found.`
        )
      }
      const federated = db.getFederatedDispatch(params.dispatch)
      if (federated) {
        const server = resolvePinnedFederatedServer(runtime, federated)
        runtime.ensureOrchestrationFederationRelay(dispatch.run_id)
        const remote = await callFederatedWorkerShow(runtime, federated)
        const attachment = remote.attachment
        if (
          attachment.state === 'succeeded' ||
          (attachment.state === 'failed' && attachment.stage === 'worker_report_queued')
        ) {
          await syncFederatedDispatch(runtime, params.dispatch).catch(() => undefined)
        } else if (['ready', 'failed', 'stopped', 'start_unknown'].includes(attachment.state)) {
          worker = db.reconcileFederatedWorkerStart({
            dispatchId: params.dispatch,
            state: attachment.state as 'ready' | 'failed' | 'stopped' | 'start_unknown',
            stage: attachment.stage,
            lastError: attachment.last_error,
            worktreeId: attachment.worktree_id,
            terminalHandle: attachment.terminal_handle,
            setupState: attachment.setup_state,
            effects: attachment.effects,
            residualResources: attachment.residualResources
          })
          if (
            attachment.state === 'ready' &&
            attachment.worktree_id &&
            attachment.terminal_handle
          ) {
            db.updateFederatedDispatchResources({
              dispatchId: params.dispatch,
              remoteRuntimeEpoch: remote.runtimeEpoch,
              worktreeId: attachment.worktree_id,
              terminalHandle: attachment.terminal_handle
            })
          }
        }
        worker = db.getWorkerDispatch(params.dispatch) as typeof worker
        return {
          dispatch: db.getDispatchContextById(params.dispatch),
          worker: exposeWorker(worker),
          server: { environmentId: server.environmentId, name: server.name },
          remoteRuntimeEpoch: remote.runtimeEpoch,
          terminal: remote.terminal,
          observation: remote.observation
        }
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
      return {
        dispatch,
        worker: exposeWorker(worker),
        terminal: observation.exact ? observation.terminal : null,
        observation: { status: observation.status, exactWorker: observation.exact }
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
        const remote = (await runtime.callOrchestrationWorkerServer(
          server.environmentId,
          'orchestration.federationRead',
          { dispatchId: params.dispatch, cursor: params.cursor, limit: params.limit },
          15_000
        )) as { runtimeEpoch: string; terminal: unknown }
        return {
          dispatchId: params.dispatch,
          server: { environmentId: server.environmentId, name: server.name },
          remoteRuntimeEpoch: remote.runtimeEpoch,
          terminal: remote.terminal
        }
      }
      const worker = db.getWorkerDispatch(params.dispatch)
      if (!worker?.agent_terminal_handle) {
        throw new OrchestrationError(
          'dispatch_not_found',
          `Worker Dispatch ${params.dispatch} has no agent terminal.`
        )
      }
      const observation = await inspectWorkerTerminal(runtime, db, params.dispatch)
      if (!observation.exact) {
        throw new OrchestrationError(
          'worker_identity_changed',
          `Worker Dispatch ${params.dispatch} no longer resolves to its exact process.`
        )
      }
      return {
        dispatchId: params.dispatch,
        terminal: await runtime.readTerminal(worker.agent_terminal_handle, {
          cursor: params.cursor,
          limit: params.limit
        })
      }
    }
  }),
  defineMethod({
    name: 'orchestration.workerAbandon',
    params: WorkerDispatchParams,
    handler: (params, { runtime }) => {
      const worker = runtime.getOrchestrationDb().abandonWorkerDispatch(params.dispatch)
      runtime.notifyMessageArrived(`dispatch:${params.dispatch}`, 'status')
      return {
        dispatchId: params.dispatch,
        state: worker.state,
        processAction: 'none',
        warning: 'Possibly-live resources were retained; no process was stopped or deleted.',
        residualResources: JSON.parse(worker.residual_resources) as unknown[]
      }
    }
  })
]
