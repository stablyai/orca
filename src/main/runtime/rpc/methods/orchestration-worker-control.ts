import { z } from 'zod'
import {
  ORCHESTRATION_WORKER_READ_SOURCES,
  type OrchestrationWorkerReadResult
} from '../../../../shared/orchestration-worker-output'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalFiniteNumber, requiredString } from '../schemas'
import {
  callFederatedWorkerShow,
  exposeWorker,
  inspectWorkerTerminal,
  resolvePinnedFederatedServer
} from './orchestration-worker-observation'
import { readArchivedWorkerOutput } from './orchestration-worker-archive-read'
import { readLegacyFederatedTerminal } from './orchestration-worker-legacy-federated-read'
import { readExactWorkerOutput } from './orchestration-worker-output'
import { exposeWorkerTerminalResource } from './orchestration-worker-release-completion'

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
        worker = db.updateWorkerSetupEvidence({
          dispatchId: params.dispatch,
          setupState: attachment.setup_state,
          effects: attachment.effects
        }).worker
        if (
          attachment.state === 'succeeded' ||
          (attachment.state === 'failed' && attachment.stage === 'worker_report_queued')
        ) {
          await runtime
            .syncOrchestrationFederatedDispatchAfterCurrent(params.dispatch)
            .catch(() => undefined)
        } else if (
          attachment.state === 'stopped' &&
          ['stopping', 'stop_unknown'].includes(worker.state)
        ) {
          worker = db.reconcileFederatedWorkerStop(params.dispatch)
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
        worker = db.getWorkerDispatch(params.dispatch)
        if (!worker) {
          throw new OrchestrationError(
            'dispatch_not_found',
            `Worker Dispatch ${params.dispatch} was not found after remote reconciliation.`
          )
        }
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
      const resource = db.getWorkerTerminalResourceByOwner(params.dispatch)
      return {
        dispatch,
        worker: exposeWorker(worker),
        terminal: observation.exact ? observation.terminal : null,
        observation: { status: observation.status, exactWorker: observation.exact },
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
        try {
          const remote = (await runtime.callOrchestrationWorkerServer(
            server.environmentId,
            'orchestration.federationReadOutput',
            {
              dispatchId: params.dispatch,
              cursor: params.cursor,
              limit: params.limit,
              source: params.source
            },
            15_000
          )) as { runtimeEpoch: string; output: OrchestrationWorkerReadResult }
          return {
            ...remote.output,
            server: { environmentId: server.environmentId, name: server.name },
            remoteRuntimeEpoch: remote.runtimeEpoch
          }
        } catch (error) {
          if (!(error instanceof OrchestrationError) || error.code !== 'method_not_found') {
            throw error
          }
          return readLegacyFederatedTerminal({
            runtime,
            server,
            federated,
            workerState: db.getWorkerDispatch(params.dispatch)?.state ?? 'unknown',
            dispatchId: params.dispatch,
            source: params.source,
            cursor: params.cursor,
            limit: params.limit
          })
        }
      }
      const worker = db.getWorkerDispatch(params.dispatch)
      if (!worker?.agent_terminal_handle) {
        throw new OrchestrationError(
          'dispatch_not_found',
          `Worker Dispatch ${params.dispatch} has no agent terminal.`
        )
      }
      const resource = db.getWorkerTerminalResourceByOwner(params.dispatch)
      if (resource && ['releasing', 'released'].includes(resource.release_state)) {
        return readArchivedWorkerOutput({
          db,
          dispatchId: params.dispatch,
          workerState: worker.state,
          resource,
          source: params.source,
          cursor: params.cursor,
          limit: params.limit
        })
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
        terminalHandle: worker.agent_terminal_handle,
        workerState: worker.state,
        terminalStatus: observation.status === 'exited' ? 'exited' : 'running',
        attachedAt: worker.created_at,
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
      return output
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

function contextOnlyAbandonWarning(result: {
  state: string
  alreadySettled: boolean
  releasedCurrentTask: boolean
}): string {
  if (result.alreadySettled) {
    return `Dispatch was already ${result.state}; no state or process changed.`
  }
  return result.releasedCurrentTask
    ? 'The assignment was abandoned; its unsupervised terminal process was retained.'
    : 'The superseded assignment was abandoned without changing the current Task or terminal process.'
}
