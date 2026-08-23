import { z } from 'zod'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import { ORCHESTRATION_FEDERATION_WORKER_RELEASE_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import {
  exposeWorkerTerminalResource,
  type WorkerTerminalListState
} from '../../orchestration/worker-terminal-ownership'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { defineMethod, type RpcMethod } from '../core'
import { requiredString } from '../schemas'
import {
  archiveSummary,
  completeWorkerTerminalRelease,
  type WorkerReleaseReceipt
} from './orchestration-worker-release-completion'
import { requireHomeAttachment } from './orchestration-federation-control'
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

export const ORCHESTRATION_WORKER_RELEASE_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.workerRelease',
    params: WorkerDispatchParams,
    handler: async (
      params,
      { runtime, authenticatedCallerFingerprint, orchestrationMutation }
    ): Promise<WorkerReleaseReceipt> => {
      const db = runtime.getOrchestrationDb()
      const federated = db.getFederatedDispatch(params.dispatch)
      if (federated) {
        return forwardFederatedWorkerMutation({
          runtime,
          federated,
          dispatchId: params.dispatch,
          method: 'orchestration.workerRelease',
          requestId: orchestrationMutation?.requestId
        })
      }
      const remoteOwner = Boolean(db.getRemoteDispatchAttachment(params.dispatch))
      if (remoteOwner) {
        requireHomeAttachment(runtime, params.dispatch, authenticatedCallerFingerprint)
      }
      const requested = db.requestWorkerTerminalRelease(
        params.dispatch,
        remoteOwner ? 'remote_attachment' : 'worker'
      )
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
          !remoteOwner &&
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
        resource: requested.resource,
        owner: remoteOwner ? 'remote_attachment' : 'worker'
      })
    }
  }),
  defineMethod({
    name: 'orchestration.workerRetain',
    params: WorkerDispatchParams,
    handler: async (params, { runtime, authenticatedCallerFingerprint, orchestrationMutation }) => {
      const db = runtime.getOrchestrationDb()
      const federated = db.getFederatedDispatch(params.dispatch)
      if (federated) {
        return forwardFederatedWorkerMutation({
          runtime,
          federated,
          dispatchId: params.dispatch,
          method: 'orchestration.workerRetain',
          requestId: orchestrationMutation?.requestId
        })
      }
      const remoteOwner = Boolean(db.getRemoteDispatchAttachment(params.dispatch))
      if (remoteOwner) {
        requireHomeAttachment(runtime, params.dispatch, authenticatedCallerFingerprint)
      }
      const retained = db.retainWorkerTerminalResource(
        params.dispatch,
        remoteOwner ? 'remote_attachment' : 'worker'
      )
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
      const db = runtime.getOrchestrationDb()
      const processIncarnation = (() => {
        try {
          const resolved = runtime.resolveTerminalPane(params.paneKey)
          return runtime.getOrchestrationDispatchAuthority(resolved.handle)?.processIncarnation
        } catch {
          return null
        }
      })()
      return { changed: db.markWorkerTerminalUserOwned(params.paneKey, processIncarnation) }
    }
  })
]

async function forwardFederatedWorkerMutation(args: {
  runtime: Parameters<typeof resolvePinnedFederatedServer>[0]
  federated: Parameters<typeof resolvePinnedFederatedServer>[1]
  dispatchId: string
  method: 'orchestration.workerRelease' | 'orchestration.workerRetain'
  requestId: string | undefined
}): Promise<WorkerReleaseReceipt> {
  if (!args.requestId) {
    throw new OrchestrationError(
      'invalid_argument',
      'Federated terminal lifecycle changes require a durable retry request.'
    )
  }
  const server = resolvePinnedFederatedServer(args.runtime, args.federated)
  try {
    const status = (await args.runtime.callOrchestrationWorkerServer(
      server.environmentId,
      'status.get',
      undefined,
      10_000
    )) as RuntimeStatus
    if (
      !status.capabilities?.includes(ORCHESTRATION_FEDERATION_WORKER_RELEASE_RUNTIME_CAPABILITY)
    ) {
      return {
        dispatchId: args.dispatchId,
        state: 'retained',
        reason: 'federation_unsupported',
        processAction: 'none',
        archive: null,
        recovery: 'The connected worker server does not support federated terminal release.'
      }
    }
    return (await args.runtime.callOrchestrationWorkerServer(
      server.environmentId,
      args.method,
      { dispatch: args.dispatchId },
      30_000,
      { orchestrationRequestId: args.requestId }
    )) as WorkerReleaseReceipt
  } catch (error) {
    if (error instanceof OrchestrationError) {
      throw error
    }
    const reason = error instanceof Error ? error.message : String(error)
    return {
      dispatchId: args.dispatchId,
      state: 'release_pending',
      processAction: 'none',
      archive: null,
      lastError: reason,
      recovery: 'The worker server is unreachable; retry with the same request ID.'
    }
  }
}
