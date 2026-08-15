import { z } from 'zod'
import { ORCHESTRATION_WORKER_READ_SOURCES } from '../../../../shared/orchestration-worker-output'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import type { RemoteDispatchAttachmentRow } from '../../orchestration/types'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalFiniteNumber, requiredString } from '../schemas'
import { readExactWorkerOutput } from './orchestration-worker-output'
import { readArchivedWorkerOutput } from './orchestration-worker-archive-read'
import { releaseRemoteAttachment } from './orchestration-federation-release'
import { archiveSummary } from './orchestration-worker-release-completion'

const FederationDispatchParams = z.object({
  dispatchId: requiredString('Missing Dispatch ID')
})
const FederationReadParams = FederationDispatchParams.extend({
  cursor: OptionalFiniteNumber,
  limit: OptionalFiniteNumber
})
const FederationOutputReadParams = FederationDispatchParams.extend({
  cursor: z.union([z.number().int().nonnegative(), z.string().min(1).max(2_048)]).optional(),
  limit: OptionalFiniteNumber,
  source: z.enum(ORCHESTRATION_WORKER_READ_SOURCES).optional()
})

export const ORCHESTRATION_FEDERATION_CONTROL_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.federationShow',
    params: FederationDispatchParams,
    handler: async (params, { runtime, authenticatedCallerFingerprint }) => {
      const attachment = requireHomeAttachment(
        runtime,
        params.dispatchId,
        authenticatedCallerFingerprint
      )
      const observation = await inspectRemoteAttachment(runtime, params.dispatchId)
      return {
        dispatchId: params.dispatchId,
        runtimeEpoch: runtime.getRuntimeId(),
        attachment: exposeRemoteAttachment(attachment),
        terminal: observation.exact ? observation.terminal : null,
        observation: { status: observation.status, exactWorker: observation.exact }
      }
    }
  }),
  defineMethod({
    name: 'orchestration.federationRead',
    params: FederationReadParams,
    handler: async (params, { runtime, authenticatedCallerFingerprint }) => {
      requireHomeAttachment(runtime, params.dispatchId, authenticatedCallerFingerprint)
      const observation = await inspectRemoteAttachment(runtime, params.dispatchId)
      if (!observation.exact || !observation.terminal || observation.status !== 'running') {
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
    params: FederationOutputReadParams,
    handler: async (params, { runtime, authenticatedCallerFingerprint }) => {
      const attachment = requireHomeAttachment(
        runtime,
        params.dispatchId,
        authenticatedCallerFingerprint
      )
      const resource = runtime
        .getOrchestrationDb()
        .getWorkerTerminalResourceByOwner(params.dispatchId)
      const hasReleaseArchive =
        resource?.release_state !== 'not_requested' &&
        Boolean(runtime.getOrchestrationDb().getWorkerTerminalArchive(params.dispatchId))
      if (
        resource &&
        (['releasing', 'released'].includes(resource.release_state) || hasReleaseArchive)
      ) {
        return {
          dispatchId: params.dispatchId,
          runtimeEpoch: runtime.getRuntimeId(),
          output: await readArchivedWorkerOutput({
            db: runtime.getOrchestrationDb(),
            dispatchId: params.dispatchId,
            workerState: attachment.state,
            resource,
            ...(params.source ? { source: params.source } : {}),
            ...(params.cursor === undefined ? {} : { cursor: params.cursor }),
            ...(params.limit === undefined ? {} : { limit: params.limit })
          })
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
        terminalStatus: observation.status === 'exited' ? 'exited' : 'running',
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
    params: FederationDispatchParams,
    handler: async (params, { runtime, authenticatedCallerFingerprint }) => {
      requireHomeAttachment(runtime, params.dispatchId, authenticatedCallerFingerprint)
      const db = runtime.getOrchestrationDb()
      const begun = db.beginRemoteAttachmentStop(params.dispatchId)
      if (['succeeded', 'failed', 'stopped', 'abandoned'].includes(begun.state)) {
        return {
          dispatchId: params.dispatchId,
          state: begun.state,
          alreadySettled: true,
          processAction: 'none'
        }
      }
      const observation = await inspectRemoteAttachment(runtime, params.dispatchId)
      if (!observation.exact || !observation.terminal) {
        const attachment = db.markRemoteAttachmentStopUnknown(
          params.dispatchId,
          `The recorded worker process is ${observation.status}; no terminal was closed.`
        )
        return {
          dispatchId: params.dispatchId,
          state: attachment.state,
          alreadySettled: false,
          processAction: 'none',
          lastError: attachment.last_error
        }
      }
      try {
        const close = await runtime.closeTerminal(observation.terminal.handle)
        const attachment = db.settleRemoteAttachmentStop(params.dispatchId)
        return {
          dispatchId: params.dispatchId,
          state: attachment.state,
          alreadySettled: false,
          processAction: 'closed_agent_terminal',
          close
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        const attachment = db.markRemoteAttachmentStopUnknown(params.dispatchId, reason)
        return {
          dispatchId: params.dispatchId,
          state: attachment.state,
          alreadySettled: false,
          processAction: 'unknown',
          lastError: reason
        }
      }
    }
  }),
  defineMethod({
    name: 'orchestration.federationRelease',
    params: FederationDispatchParams,
    handler: async (params, { runtime, authenticatedCallerFingerprint }) => {
      const attachment = requireHomeAttachment(
        runtime,
        params.dispatchId,
        authenticatedCallerFingerprint
      )
      return releaseRemoteAttachment({
        runtime,
        db: runtime.getOrchestrationDb(),
        attachment
      })
    }
  }),
  defineMethod({
    name: 'orchestration.federationRetain',
    params: FederationDispatchParams,
    handler: (params, { runtime, authenticatedCallerFingerprint }) => {
      requireHomeAttachment(runtime, params.dispatchId, authenticatedCallerFingerprint)
      const retained = runtime.getOrchestrationDb().retainWorkerTerminalResource(params.dispatchId)
      if (retained.disposition === 'already_released') {
        return {
          dispatchId: params.dispatchId,
          state: 'already_released' as const,
          processAction: 'none' as const,
          archive: archiveSummary(retained.resource)
        }
      }
      if (retained.disposition === 'no_owned_resource') {
        return {
          dispatchId: params.dispatchId,
          state: 'retained' as const,
          reason: 'no_owned_resource' as const,
          processAction: 'none' as const,
          archive: null
        }
      }
      if (retained.disposition === 'release_committed') {
        return {
          dispatchId: params.dispatchId,
          state:
            retained.resource.release_state === 'unknown'
              ? ('release_unknown' as const)
              : ('release_pending' as const),
          processAction: 'none' as const,
          archive: archiveSummary(retained.resource),
          ...(retained.resource.release_error ? { lastError: retained.resource.release_error } : {})
        }
      }
      return {
        dispatchId: params.dispatchId,
        state: 'retained' as const,
        reason: 'user_requested' as const,
        processAction: 'none' as const,
        archive: archiveSummary(retained.resource)
      }
    }
  })
]

function requireHomeAttachment(
  runtime: OrcaRuntimeService,
  dispatchId: string,
  callerFingerprint: string | undefined
): RemoteDispatchAttachmentRow {
  const attachment = runtime.getOrchestrationDb().getRemoteDispatchAttachment(dispatchId)
  if (!attachment || attachment.home_peer_fingerprint !== callerFingerprint) {
    throw new OrchestrationError(
      'dispatch_not_found',
      `Remote Dispatch ${dispatchId} was not found for this Run home.`
    )
  }
  return attachment
}

async function inspectRemoteAttachment(runtime: OrcaRuntimeService, dispatchId: string) {
  const db = runtime.getOrchestrationDb()
  const attachment = db.getRemoteDispatchAttachment(dispatchId)
  if (!attachment?.terminal_handle) {
    return { terminal: null, exact: false, status: 'unattached' as const }
  }
  const terminal = await runtime.showTerminal(attachment.terminal_handle).catch(() => null)
  if (!terminal) {
    return { terminal: null, exact: false, status: 'missing' as const }
  }
  const exact = db.isRemoteAttachmentProcessCurrent({
    dispatchId,
    paneKey: runtime.getTerminalPaneKey(attachment.terminal_handle),
    processIncarnation: runtime.getTerminalProcessIncarnation(attachment.terminal_handle)
  })
  return {
    terminal,
    exact,
    status: exact
      ? terminal.connected === false
        ? ('exited' as const)
        : ('running' as const)
      : ('identity_changed' as const)
  }
}

function exposeRemoteAttachment(attachment: RemoteDispatchAttachmentRow) {
  return {
    ...attachment,
    effects: JSON.parse(attachment.effects) as unknown[],
    residualResources: JSON.parse(attachment.residual_resources) as unknown[]
  }
}
