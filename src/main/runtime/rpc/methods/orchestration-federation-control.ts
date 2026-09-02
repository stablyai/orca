import { z } from 'zod'
import { ORCHESTRATION_WORKER_READ_SOURCES } from '../../../../shared/orchestration-worker-output'
import type { RuntimeTerminalInteractiveWait } from '../../../../shared/runtime-types'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import type { RemoteDispatchAttachmentRow } from '../../orchestration/types'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalFiniteNumber, requiredString } from '../schemas'
import { readExactWorkerOutput } from './orchestration-worker-output'
import { describeUnconfirmedAgentStop } from '../../../../shared/pty-liveness-verdict'

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
    params: FederationReadParams,
    handler: async (params, { runtime, authenticatedCallerFingerprint }) => {
      requireHomeAttachment(runtime, params.dispatchId, authenticatedCallerFingerprint)
      const observation = await inspectRemoteAttachment(runtime, params.dispatchId)
      // Why `=== 'exited'` rather than `!== 'live'`: the other non-live
      // statuses are already covered by the two guards, and an unverifiable
      // terminal is still readable — losing stop-contact is not an exit.
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
    params: FederationOutputReadParams,
    handler: async (params, { runtime, authenticatedCallerFingerprint }) => {
      const attachment = requireHomeAttachment(
        runtime,
        params.dispatchId,
        authenticatedCallerFingerprint
      )
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
        if (!close.ptyKilled) {
          // The tab is retired but the process was never confirmed stopped, so
          // the coordinator must not be told this dispatch reached 'stopped'.
          const attachment = db.markRemoteAttachmentStopUnknown(
            params.dispatchId,
            describeUnconfirmedAgentStop(close)
          )
          return {
            dispatchId: params.dispatchId,
            state: attachment.state,
            alreadySettled: false,
            processAction: 'closed_agent_terminal',
            lastError: attachment.last_error,
            close
          }
        }
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

async function inspectRemoteAttachment(
  runtime: OrcaRuntimeService,
  dispatchId: string
): Promise<{
  terminal: Awaited<ReturnType<OrcaRuntimeService['showTerminal']>> | null
  exact: boolean
  status: 'unattached' | 'missing' | 'identity_changed' | 'live' | 'exited' | 'unverifiable'
  /** Set with `unverifiable`; names what we lost contact with. */
  reason?: string
  /** Set only on a proven-exact attachment parked on a prompt that needs a human. */
  agentWait?: RuntimeTerminalInteractiveWait | null
}> {
  const db = runtime.getOrchestrationDb()
  const attachment = db.getRemoteDispatchAttachment(dispatchId)
  if (!attachment?.terminal_handle) {
    return { terminal: null, exact: false, status: 'unattached' }
  }
  const terminal = await runtime.showTerminal(attachment.terminal_handle).catch(() => null)
  if (!terminal) {
    return { terminal: null, exact: false, status: 'missing' }
  }
  const exact = db.isRemoteAttachmentProcessCurrent({
    dispatchId,
    paneKey: runtime.getTerminalPaneKey(attachment.terminal_handle),
    processIncarnation: runtime.getTerminalProcessIncarnation(attachment.terminal_handle)
  })
  if (!exact) {
    return { terminal, exact, status: 'identity_changed' }
  }
  // Why: the same rule as the local worker observation — the inventory only
  // iterates registered providers, so a dropped relay clears `connected` for
  // every remote PTY at once. Lost contact is not a death certificate.
  // Why reused: showTerminal above already scanned this pane's tail for the same verdict.
  const agentWait = terminal.agentWait
  const verdict = runtime.getTerminalLivenessVerdict?.(attachment.terminal_handle) ?? null
  if (verdict?.status === 'unverifiable') {
    return { terminal, exact, status: 'unverifiable', reason: verdict.reason, agentWait }
  }
  return {
    terminal,
    exact,
    status: verdict?.status !== 'live' && terminal.connected === false ? 'exited' : 'live',
    agentWait
  }
}

function exposeRemoteAttachment(attachment: RemoteDispatchAttachmentRow) {
  return {
    ...attachment,
    effects: JSON.parse(attachment.effects) as unknown[],
    residualResources: JSON.parse(attachment.residual_resources) as unknown[]
  }
}
