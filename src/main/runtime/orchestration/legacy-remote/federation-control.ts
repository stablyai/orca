import { OrchestrationError } from '../orchestration-error'
import type { RemoteDispatchAttachmentRow } from '../db/orchestration-records'
import { defineMethod } from '../../rpc/core'
import { isUserKeptWorkerTerminalOwner } from '../db/worker-terminal/worker-terminal-user-keep'
import { mapWithConcurrency } from '../../../../shared/map-with-concurrency'
import { readExactWorkerOutput } from '../../rpc/methods/orchestration/worker/worker-output'
import { exposeWorkerRetainReceipt } from '../../rpc/methods/orchestration/worker/worker-terminal-resource-presentation'
import { withStoppedHelpers } from '../../rpc/methods/orchestration/worker/worker-stop'
import { stopRemoteAttachment } from './federated-worker-stop-host'
import {
  inspectRemoteAttachment,
  observeRemoteAttachmentLiveness,
  requireHomeAttachment
} from './federation-attachment-observation'
import { releaseRemoteAttachment } from './federated-worker-release-host'
import { readRemoteAttachmentArchive } from './remote-attachment-archive-read'
import {
  FederationDispatchParams,
  FederationFleetSnapshotParams,
  FederationOutputReadParams,
  FederationReadParams
} from '../../../../shared/rpc-contract/orchestration-federation-control-params'

export const ORCHESTRATION_FEDERATION_CONTROL_METHODS = [
  defineMethod({
    name: 'orchestration.federationFleetSnapshot',
    permission: 'workspace',
    params: FederationFleetSnapshotParams,
    handler: async (params, { runtime, authenticatedCallerFingerprint }) => {
      const items = await mapWithConcurrency(params.dispatchIds, 16, async (dispatchId) => {
        const attachment = runtime.getOrchestrationDb().getRemoteDispatchAttachment(dispatchId)
        // A Dispatch this home no longer holds here, such as one from an earlier pairing, must not hide the rest.
        if (!attachment || attachment.home_peer_fingerprint !== authenticatedCallerFingerprint) {
          return {
            dispatchId,
            observation: { status: 'unverifiable' as const, exactWorker: false }
          }
        }
        const observation = await observeRemoteAttachmentLiveness(runtime, dispatchId)
        const db = runtime.getOrchestrationDb()
        const autoReleaseAt = db.getLiveWorkerTerminalAutoReleaseAt(dispatchId)
        return {
          dispatchId,
          observation: {
            status:
              observation.status === 'live' || observation.status === 'exited'
                ? observation.status
                : 'unverifiable',
            exactWorker: observation.exact,
            ...(observation.reason ? { reason: observation.reason } : {}),
            ...(db.getRemoteDispatchAttachment(dispatchId)?.stage === 'released'
              ? { released: true }
              : {}),
            ...(autoReleaseAt ? { autoReleaseAt } : {})
          }
        }
      })
      return { runtimeEpoch: runtime.getRuntimeId(), items }
    }
  }),
  defineMethod({
    name: 'orchestration.federationRelease',
    permission: 'workspace',
    params: FederationDispatchParams,
    handler: async (params, { runtime, authenticatedCallerFingerprint }) => {
      const attachment = requireHomeAttachment(
        runtime,
        params.dispatchId,
        authenticatedCallerFingerprint
      )
      const observation = await inspectRemoteAttachment(runtime, params.dispatchId)
      return releaseRemoteAttachment({ runtime, attachment, observation })
    }
  }),
  defineMethod({
    name: 'orchestration.federationRetain',
    permission: 'workspace',
    params: FederationDispatchParams,
    handler: (params, { runtime, authenticatedCallerFingerprint }) => {
      requireHomeAttachment(runtime, params.dispatchId, authenticatedCallerFingerprint)
      return exposeWorkerRetainReceipt(
        params.dispatchId,
        runtime.getOrchestrationDb().retainRemoteAttachmentTerminalResource(params.dispatchId)
      )
    }
  }),
  defineMethod({
    name: 'orchestration.federationShow',
    permission: 'workspace',
    params: FederationDispatchParams,
    handler: async (params, { runtime, authenticatedCallerFingerprint }) => {
      const attachment = requireHomeAttachment(
        runtime,
        params.dispatchId,
        authenticatedCallerFingerprint
      )
      const observation = await observeRemoteAttachmentLiveness(runtime, params.dispatchId)
      return {
        dispatchId: params.dispatchId,
        runtimeEpoch: runtime.getRuntimeId(),
        attachment: exposeRemoteAttachment(attachment),
        autoReleaseAt: runtime
          .getOrchestrationDb()
          .getLiveWorkerTerminalAutoReleaseAt(params.dispatchId),
        keptOpen: isUserKeptWorkerTerminalOwner(runtime.getOrchestrationDb(), params.dispatchId),
        terminal: observation.exact ? observation.terminal : null,
        observation: {
          status: observation.status,
          exactWorker: observation.exact,
          ...(observation.reason ? { reason: observation.reason } : {}),
          ...(observation.agentWait !== undefined ? { agentWait: observation.agentWait } : {})
        }
      }
    }
  }),
  defineMethod({
    name: 'orchestration.federationRead',
    permission: 'workspace',
    params: FederationReadParams,
    handler: async (params, { runtime, authenticatedCallerFingerprint }) => {
      requireHomeAttachment(runtime, params.dispatchId, authenticatedCallerFingerprint)
      const observation = await inspectRemoteAttachment(runtime, params.dispatchId)
      // Only exited proves death; an unverifiable terminal may still be readable after stop-contact loss.
      if (!observation.exact || !observation.terminal || observation.status === 'exited') {
        throw new OrchestrationError(
          'worker_identity_changed',
          `Remote Dispatch ${params.dispatchId} no longer resolves to its exact process.`
        )
      }
      return {
        dispatchId: params.dispatchId,
        runtimeEpoch: runtime.getRuntimeId(),
        terminal: await runtime.readTerminal(observation.terminal.handle, {
          cursor: params.cursor,
          limit: params.limit
        })
      }
    }
  }),
  defineMethod({
    name: 'orchestration.federationReadOutput',
    permission: 'workspace',
    params: FederationOutputReadParams,
    handler: async (params, { runtime, authenticatedCallerFingerprint }) => {
      const attachment = requireHomeAttachment(
        runtime,
        params.dispatchId,
        authenticatedCallerFingerprint
      )
      const storedArchive = runtime
        .getOrchestrationDb()
        .getWorkerTerminalArchive(attachment.dispatch_id)
      if (storedArchive) {
        const archivedObservation =
          attachment.stage === 'released'
            ? null
            : await inspectRemoteAttachment(runtime, params.dispatchId)
        const output = await readRemoteAttachmentArchive({
          runtime,
          attachment,
          source: params.source,
          cursor: params.cursor,
          limit: params.limit,
          liveness:
            attachment.stage === 'released' || archivedObservation?.status === 'exited'
              ? 'exited'
              : archivedObservation?.exact && archivedObservation.terminal
                ? archivedObservation.status === 'live'
                  ? 'live'
                  : 'unverifiable'
                : 'unverifiable'
        })
        if (output) {
          return {
            dispatchId: params.dispatchId,
            runtimeEpoch: runtime.getRuntimeId(),
            output
          }
        }
      }
      const observation = await inspectRemoteAttachment(runtime, params.dispatchId)
      if (!observation.exact || !observation.terminal) {
        throw new OrchestrationError(
          'worker_identity_changed',
          `Remote Dispatch ${params.dispatchId} no longer resolves to its exact process.`
        )
      }
      const output = await readExactWorkerOutput({
        runtime,
        dispatchId: params.dispatchId,
        terminalHandle: observation.terminal.handle,
        workerState: attachment.state,
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
        attachedAt: attachment.created_at,
        source: params.source,
        cursor: params.cursor,
        limit: params.limit
      })
      const afterRead = await inspectRemoteAttachment(runtime, params.dispatchId)
      if (!afterRead.exact) {
        throw new OrchestrationError(
          'worker_identity_changed',
          `Remote Dispatch ${params.dispatchId} changed process while output was read.`
        )
      }
      return {
        dispatchId: params.dispatchId,
        runtimeEpoch: runtime.getRuntimeId(),
        output
      }
    }
  }),
  defineMethod({
    name: 'orchestration.federationStop',
    permission: 'workspace',
    params: FederationDispatchParams,
    handler: async (params, { runtime, authenticatedCallerFingerprint, orchestrationMutation }) => {
      requireHomeAttachment(runtime, params.dispatchId, authenticatedCallerFingerprint)
      // Helpers this worker started on this host are only in this host's database.
      return withStoppedHelpers(
        runtime,
        params.dispatchId,
        orchestrationMutation,
        await stopRemoteAttachment(runtime, params)
      )
    }
  })
]

function exposeRemoteAttachment(attachment: RemoteDispatchAttachmentRow) {
  return {
    ...attachment,
    effects: JSON.parse(attachment.effects) as unknown[],
    residualResources: JSON.parse(attachment.residual_resources) as unknown[]
  }
}
