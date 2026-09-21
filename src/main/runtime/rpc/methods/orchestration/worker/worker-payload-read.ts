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
import { MAX_UTF8_START_ALIGNMENT } from '../../../../../native-chat/agent-session-journal/journal-payload-file-bytes'
import { resolvePinnedFederatedServer } from './worker-observation'
import { getOrchestrationPeerCapabilityCache } from '../../../../orchestration/orchestration-peer-capability-cache'

/** Largest chunk one reply carries; callers page with `offset`. */
export const WORKER_PAYLOAD_READ_MAX_LIMIT = 256 * 1024

/** The retention scope a Dispatch's own transcript reads are recorded under. */
export function dispatchPayloadScope(dispatchId: string): string {
  return `dispatch:${dispatchId}`
}

export type WorkerPayloadReadResult = JournalPayloadRange & {
  dispatchId: string
  server?: { environmentId: string; name: string }
}

/** A payload this host retained while reading THIS Dispatch's transcript; the
 *  Dispatch's own read scope is the ownership proof. */
export function readLocalDispatchPayload(input: {
  dispatchId: string
  digest: string
  offset?: number
  limit?: number
}): WorkerPayloadReadResult {
  const retention = getDefaultJournalPayloadRetention()
  const range = readOwnedPayloadRange({
    retention,
    // A transcript has no journal, so the scope index recorded at clip time is
    // the only ownership proof this read has.
    isReferenced: () =>
      retention !== null && retention.isReferencedBy(input.digest, dispatchPayloadScope(input.dispatchId)),
    digest: input.digest,
    offset: input.offset,
    limit: input.limit,
    maxLimit: WORKER_PAYLOAD_READ_MAX_LIMIT
  })
  return { ...range, dispatchId: input.dispatchId }
}

/** What the caller asked the peer for; the reply is only accepted as an answer
 *  to exactly this. */
export type RemotePayloadRequest = { digest: string; offset?: number }

/**
 * The remote reply is untrusted wire data. It is bound to the request before
 * its bytes are ever presented as content: a stale or wrong reply that named a
 * different digest, or whose offsets do not describe the bytes it carries,
 * would otherwise be shown as the requested payload and would hand the pager a
 * continuation offset that walks off the payload.
 */
export function parseRemotePayloadReply(
  value: unknown,
  request: RemotePayloadRequest
): { runtimeEpoch: string; payload: JournalPayloadRange } {
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
    typeof digest !== 'string' || typeof chunk !== 'string' || typeof complete !== 'boolean'
    || !isByteCount(byteLength) || !isByteCount(chunkOffset) || !isByteCount(chunkByteLength)
  ) {
    throw malformedRemoteReply()
  }
  const requestedOffset = request.offset ?? 0
  if (
    // The reply must answer the digest that was asked for, and nothing else.
    digest !== request.digest
    || Buffer.byteLength(chunk, 'utf8') !== chunkByteLength
    // The host aligns a mid-code-point offset forward to the next UTF-8 lead
    // byte, so the answer may begin a little past the request but never before
    // it, and never further than one character's worth of continuation bytes.
    || chunkOffset < requestedOffset
    || chunkOffset - requestedOffset > MAX_UTF8_START_ALIGNMENT
    || chunkOffset + chunkByteLength > byteLength
    // A peer that returns nothing and calls it unfinished hands the pager an
    // offset that never advances; that is a broken answer, not a short one.
    || (chunkByteLength === 0 && !complete)
    // `complete` is what stops the pager; it must mean the payload's real end.
    || complete !== (chunkOffset + chunkByteLength === byteLength)
  ) {
    throw malformedRemoteReply()
  }
  return {
    runtimeEpoch: record['runtimeEpoch'],
    payload: { digest, chunk, byteLength, chunkOffset, chunkByteLength, complete }
  }
}

/** A byte count on the wire: a safe non-negative integer, never a float. */
function isByteCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** One code for every way a reply fails its binding: a caller cannot tell which
 *  check tripped, and none of them means the content is trustworthy. */
function malformedRemoteReply(): OrchestrationError {
  return new OrchestrationError('payload_integrity_failed',
    'The execution host returned a malformed payload reply; refusing to present it as content.')
}

/** Keeps the reader's specific refusal code on the wire instead of flattening it. */
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

/** Forwards the read to the Dispatch's pinned execution host. A host that
 *  predates this method is remembered as unsupported so the next read says so
 *  immediately instead of paying another round trip. */
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
      ),
      { digest: args.params.digest, offset: args.params.offset }
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
