import { z } from 'zod'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import type { WorkerTerminalListState } from '../../orchestration/worker-terminal-ownership'
import { defineMethod, type RpcMethod } from '../core'
import { requiredString } from '../schemas'
import {
  archiveSummary,
  completeWorkerTerminalRelease,
  exposeWorkerTerminalResource,
  type WorkerReleaseReceipt
} from './orchestration-worker-release-completion'
import { resolvePinnedFederatedServer } from './orchestration-worker-observation'

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

function legacyRemoteCleanupReceipt(dispatchId: string, action: 'release' | 'retention') {
  return {
    dispatchId,
    state: 'retained' as const,
    reason: 'ownership_transferred' as const,
    processAction: 'none' as const,
    archive: null,
    recovery: `The pinned worker server cannot perform managed ${action}; the remote terminal was preserved.`
  }
}

function isLegacyRemoteCleanupError(error: unknown): boolean {
  return (
    error instanceof OrchestrationError &&
    ['orchestration_migration_required', 'method_not_found', 'capability_unsupported'].includes(
      error.code
    )
  )
}

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
        const worker = db.getWorkerDispatch(params.dispatch)
        if (!worker || !['succeeded', 'failed', 'stopped', 'stop_unknown'].includes(worker.state)) {
          throw new OrchestrationError(
            'dispatch_inactive',
            `Federated Dispatch ${params.dispatch} is not settled for release.`
          )
        }
        const server = resolvePinnedFederatedServer(runtime, federated)
        let remote: {
          state:
            | 'released'
            | 'already_released'
            | 'retained'
            | 'release_pending'
            | 'release_unknown'
          reason?: WorkerReleaseReceipt['reason']
          processAction: 'closed_agent_terminal' | 'closed_exited_terminal' | 'none'
          archive: WorkerReleaseReceipt['archive']
          recovery?: string
          lastError?: string
        }
        try {
          remote = (await runtime.callOrchestrationWorkerServer(
            server.environmentId,
            'orchestration.federationRelease',
            { dispatchId: params.dispatch },
            30_000,
            { orchestrationRequestId: orchestrationMutation.requestId }
          )) as typeof remote
        } catch (error) {
          if (isLegacyRemoteCleanupError(error)) {
            return legacyRemoteCleanupReceipt(params.dispatch, 'release')
          }
          throw error
        }
        return {
          dispatchId: params.dispatch,
          state: remote.state,
          processAction: remote.processAction,
          archive: remote.archive,
          ...(remote.reason ? { reason: remote.reason } : {}),
          ...(remote.recovery ? { recovery: remote.recovery } : {}),
          ...(remote.lastError ? { lastError: remote.lastError } : {})
        }
      }
      if (!db.getWorkerDispatch(params.dispatch)) {
        const dispatch = db.getDispatchContextById(params.dispatch)
        if (!dispatch) {
          throw new OrchestrationError(
            'dispatch_not_found',
            `Worker Dispatch ${params.dispatch} was not found.`
          )
        }
        if (!['completed', 'failed', 'circuit_broken'].includes(dispatch.status)) {
          throw new OrchestrationError(
            'dispatch_inactive',
            `Dispatch ${params.dispatch} is ${dispatch.status}; only a settled Dispatch can release.`
          )
        }
        return {
          dispatchId: params.dispatch,
          state: 'retained',
          reason: 'no_owned_resource',
          processAction: 'none',
          archive: null,
          recovery:
            'This low-level Dispatch has no worker-start terminal ownership; the terminal was preserved. Use worker-start for managed cleanup.'
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
          )) === 'dead'
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
    handler: async (params, { runtime, orchestrationMutation }) => {
      const db = runtime.getOrchestrationDb()
      const federated = db.getFederatedDispatch(params.dispatch)
      if (federated) {
        if (!orchestrationMutation) {
          throw new OrchestrationError(
            'invalid_argument',
            'Remote worker-retain requires a durable retry request.'
          )
        }
        const server = resolvePinnedFederatedServer(runtime, federated)
        try {
          return await runtime.callOrchestrationWorkerServer(
            server.environmentId,
            'orchestration.federationRetain',
            { dispatchId: params.dispatch },
            30_000,
            { orchestrationRequestId: orchestrationMutation.requestId }
          )
        } catch (error) {
          if (isLegacyRemoteCleanupError(error)) {
            return legacyRemoteCleanupReceipt(params.dispatch, 'retention')
          }
          throw error
        }
      }
      if (!db.getWorkerDispatch(params.dispatch)) {
        throw new OrchestrationError(
          'dispatch_not_found',
          `Worker Dispatch ${params.dispatch} was not found.`
        )
      }
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
    handler: (params, { runtime }) => ({
      changed: runtime.getOrchestrationDb().markWorkerTerminalUserOwned(params.paneKey)
    })
  })
]
