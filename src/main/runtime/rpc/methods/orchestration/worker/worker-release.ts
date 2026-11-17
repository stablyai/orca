import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { defineOrchestrationMethod } from '../access/orchestration-method-access'
import {
  releaseFederatedWorker,
  retainFederatedWorker
} from '../../../../orchestration/legacy-remote-home/federated-worker-release'
import { ORCHESTRATION_WORKER_LIST_METHOD } from './worker-list-method'
import { resolvePinnedFederatedServer } from '../../../../orchestration/legacy-remote-home/pinned-federated-server'
import {
  archiveSummary,
  exposeWorkerRetainReceipt
} from './release/worker-terminal-resource-presentation'
import {
  completeWorkerTerminalRelease,
  type WorkerReleaseReceipt
} from './release/worker-release-completion'
import {
  WorkerDispatchParams,
  WorkerRetainParams
} from '../../../../../../shared/rpc-contract/orchestration/orchestration-worker-release-schemas-params'
import { ORCHESTRATION_WORKER_KEEP_OPEN_METHODS } from './worker-keep-open'
import { getStructuredAgentSessionHost } from '../../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { structuredSessionReleaseSettled } from '../../../../orchestration/terminal-authority/structured-sessions/structured-session-release-settlement'
import { sessionIdFromStructuredWorkerIncarnation } from '../../../../orchestration/terminal-authority/structured-sessions/structured-worker-identity'
import { agentSessionReservationProbeObservedLife } from '../../../../agent-session/ownership/agent-session-process-identity-probe'
import type { AgentSessionOwnerProbe } from '../../../../../../shared/agent-session/lifecycle/leases/agent-session-lease-adjudication'
import type { OrcaRuntimeService } from '../../../../orca-runtime'

/** Reconcile a settled structured worker's session lease before release judges it: an abandoned
 *  start can strand a reservation that no chat flow ever re-adjudicates (#43039). Probe the
 *  stranded reservation first — eviction clears the spawn token its life evidence depends on. */
async function reconcileStructuredSessionLease(
  runtime: Pick<OrcaRuntimeService, 'ensureStructuredAgentSessionHost'>,
  sessionId: string
): Promise<AgentSessionOwnerProbe | null> {
  await runtime.ensureStructuredAgentSessionHost().catch(() => undefined)
  const host = getStructuredAgentSessionHost()
  if (!host) {
    return null
  }
  const record = host.deps.store.getRecord(sessionId)
  const stranded =
    record !== null &&
    record.lease.unreconciled === true &&
    record.lease.ownerProcess === null &&
    record.lease.claimStatus === 'reserved'
  const probe = stranded && record ? await host.deps.probeOwner?.(record) : undefined
  await host.reconcileRestartLeases?.()
  return probe ?? null
}

export const ORCHESTRATION_WORKER_RELEASE_METHODS = [
  defineOrchestrationMethod({
    name: 'orchestration.workerRelease',
    access: { kind: 'writes', targets: { dispatch: 'dispatch' } },
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
          server: await resolvePinnedFederatedServer(runtime, federated),
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
        const structuredSessionId = sessionIdFromStructuredWorkerIncarnation(
          resource?.process_incarnation
        )
        const strandedReservationProbe = structuredSessionId
          ? await reconcileStructuredSessionLease(runtime, structuredSessionId)
          : null
        const liveness = resource?.process_incarnation
          ? await runtime.inspectTerminalProcessIncarnationLiveness(
              resource.process_incarnation,
              resource.host_scope
            )
          : null
        // A stopped/abandoned structured worker settles when its session is proven dead, or when
        // its reconciled lease names nothing that could still run and the probe saw no life.
        const settleDead =
          liveness === 'exited' ||
          (requested.reason === 'identity_unproven' &&
            structuredSessionId !== null &&
            !agentSessionReservationProbeObservedLife(strandedReservationProbe) &&
            structuredSessionReleaseSettled(structuredSessionId))
        if (resource?.process_incarnation && settleDead) {
          const reconciled = db.settleDeadWorkerTerminalRelease({
            requestingDispatchId: params.dispatch,
            resourceId: resource.id,
            processIncarnation: resource.process_incarnation
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
  defineOrchestrationMethod({
    name: 'orchestration.workerRetain',
    access: { kind: 'writes', targets: { dispatch: 'dispatch' } },
    permission: 'workspace',
    params: WorkerRetainParams,
    handler: async (params, { runtime, orchestrationMutation }): Promise<WorkerReleaseReceipt> => {
      const db = runtime.getOrchestrationDb()
      const federated = db.getFederatedDispatch(params.dispatch)
      if (federated) {
        if (!orchestrationMutation) {
          throw new OrchestrationError(
            'invalid_argument',
            'Remote worker-keep-open requires a durable retry request.'
          )
        }
        db.endFederatedHomeAutoRelease(params.dispatch)
        const forwarded = await retainFederatedWorker({
          runtime,
          server: await resolvePinnedFederatedServer(runtime, federated),
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
