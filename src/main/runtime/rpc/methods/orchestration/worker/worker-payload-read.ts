// `orchestration.workerPayloadRead`: exact bytes of a retained full payload
// that a `worker-read` of this Dispatch clipped. Ownership is the Dispatch's
// own read scope: only digests retained while reading THIS Dispatch's
// transcript are admitted, so a digest observed elsewhere is refused.

import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { defineMethod } from '../../../core'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { FederatedDispatchRow } from '../../../../orchestration/types'
import { WorkerPayloadReadParams } from '../../../../../../shared/rpc-contract/orchestration-worker-control-params'
import { AGENT_SESSION_PAYLOAD_READ_RUNTIME_CAPABILITY } from '../../../../../../shared/protocol-version'
import {
  getDefaultJournalPayloadRetention,
  type JournalPayloadRange
} from '../../../../../native-chat/agent-session-journal/journal-payload-store'
import {
  PayloadReadError,
  readOwnedPayloadRange
} from '../../../../../native-chat/agent-session-journal/journal-payload-read'
import { resolvePinnedFederatedServer } from './worker-observation'
import { getOrchestrationPeerCapabilityCache } from '../../../../orchestration/orchestration-peer-capability-cache'

/** Largest chunk one reply carries; callers page with `offset`. */
export const WORKER_PAYLOAD_READ_MAX_LIMIT = 256 * 1024

export function dispatchPayloadScope(dispatchId: string): string {
  return `dispatch:${dispatchId}`
}

export type WorkerPayloadReadResult = JournalPayloadRange & {
  dispatchId: string
  server?: { environmentId: string; name: string }
}

export function readLocalDispatchPayload(input: {
  dispatchId: string
  digest: string
  offset?: number
  limit?: number
}): WorkerPayloadReadResult {
  const retention = getDefaultJournalPayloadRetention()
  const range = readOwnedPayloadRange({
    retention,
    isReferenced: () =>
      retention !== null && retention.isReferencedBy(input.digest, dispatchPayloadScope(input.dispatchId)),
    digest: input.digest,
    offset: input.offset,
    limit: input.limit,
    maxLimit: WORKER_PAYLOAD_READ_MAX_LIMIT
  })
  return { ...range, dispatchId: input.dispatchId }
}

/** The remote reply is untrusted wire data: verify its shape and the digest it
 *  claims before treating the bytes as the requested payload. */
function parseRemotePayloadReply(value: unknown): { runtimeEpoch: string; payload: JournalPayloadRange } {
  if (typeof value !== 'object' || value === null) {
    throw malformedRemoteReply()
  }
  const record: Record<string, unknown> = Object.fromEntries(Object.entries(value))
  const payloadValue = record['payload']
  if (typeof record['runtimeEpoch'] !== 'string' || typeof payloadValue !== 'object' || payloadValue === null) {
    throw malformedRemoteReply()
  }
  const payload: Record<string, unknown> = Object.fromEntries(Object.entries(payloadValue))
  const digest = payload['digest']
  const chunk = payload['chunk']
  const byteLength = payload['byteLength']
  const chunkOffset = payload['chunkOffset']
  const chunkByteLength = payload['chunkByteLength']
  const complete = payload['complete']
  if (
    typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest) || typeof chunk !== 'string'
    || typeof byteLength !== 'number' || typeof chunkOffset !== 'number'
    || typeof chunkByteLength !== 'number' || typeof complete !== 'boolean'
    || Buffer.byteLength(chunk, 'utf8') !== chunkByteLength
  ) {
    throw malformedRemoteReply()
  }
  return {
    runtimeEpoch: record['runtimeEpoch'],
    payload: { digest, chunk, byteLength, chunkOffset, chunkByteLength, complete }
  }
}

function malformedRemoteReply(): OrchestrationError {
  return new OrchestrationError('payload_integrity_failed',
    'The execution host returned a malformed payload reply; refusing to present it as content.')
}

function toOrchestrationError(error: unknown): unknown {
  return error instanceof PayloadReadError
    ? new OrchestrationError(error.code, error.message)
    : error
}

export const ORCHESTRATION_WORKER_PAYLOAD_METHODS = [
  defineMethod({
    name: 'orchestration.workerPayloadRead',
    params: WorkerPayloadReadParams,
    handler: async (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const federated = db.getFederatedDispatch(params.dispatch)
      if (federated) {
        return readFederatedDispatchPayload({ runtime, federated, params })
      }
      const dispatch = db.getDispatchContextById(params.dispatch)
      if (!dispatch) {
        throw new OrchestrationError(
          'dispatch_not_found',
          `Dispatch ${params.dispatch} was not found.`
        )
      }
      try {
        return readLocalDispatchPayload({
          dispatchId: params.dispatch,
          digest: params.digest,
          offset: params.offset,
          limit: params.limit
        })
      } catch (error) {
        throw toOrchestrationError(error)
      }
    }
  })
]

async function readFederatedDispatchPayload(args: {
  runtime: OrcaRuntimeService
  federated: FederatedDispatchRow
  params: { dispatch: string; digest: string; offset?: number; limit?: number }
}): Promise<WorkerPayloadReadResult> {
  const server = resolvePinnedFederatedServer(args.runtime, args.federated)
  const capabilities = getOrchestrationPeerCapabilityCache(args.runtime)
  const known = capabilities.knownSupport(
    args.federated.peer_fingerprint,
    args.federated.remote_runtime_epoch,
    AGENT_SESSION_PAYLOAD_READ_RUNTIME_CAPABILITY
  )
  if (known?.supported === false) {
    throw new OrchestrationError(
      'payload_read_unsupported',
      `The execution host of Dispatch ${args.params.dispatch} predates retained payload reads; its clipped output has no full-content route.`
    )
  }
  try {
    const remote = parseRemotePayloadReply(
      await args.runtime.callOrchestrationWorkerServer(
        server.environmentId,
        'orchestration.federationReadPayload',
        {
          dispatchId: args.params.dispatch,
          digest: args.params.digest,
          offset: args.params.offset,
          limit: args.params.limit
        },
        15_000,
        undefined,
        { expectedEnvironmentPairingRevision: server.pairingRevision }
      )
    )
    capabilities.remember(
      args.federated.peer_fingerprint,
      remote.runtimeEpoch,
      AGENT_SESSION_PAYLOAD_READ_RUNTIME_CAPABILITY,
      true,
      known?.runtimeEpoch ?? args.federated.remote_runtime_epoch
    )
    return {
      ...remote.payload,
      dispatchId: args.params.dispatch,
      server: { environmentId: server.environmentId, name: server.name }
    }
  } catch (error) {
    if (error instanceof OrchestrationError && error.code === 'method_not_found') {
      const epoch = known?.runtimeEpoch ?? args.federated.remote_runtime_epoch
      if (epoch) {
        capabilities.remember(
          args.federated.peer_fingerprint,
          epoch,
          AGENT_SESSION_PAYLOAD_READ_RUNTIME_CAPABILITY,
          false,
          epoch
        )
      }
      throw new OrchestrationError(
        'payload_read_unsupported',
        `The execution host of Dispatch ${args.params.dispatch} predates retained payload reads; its clipped output has no full-content route.`
      )
    }
    throw error
  }
}
