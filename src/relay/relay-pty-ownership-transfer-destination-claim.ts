import { createHash, timingSafeEqual } from 'node:crypto'
import { supportsRelayPtySourceRetirement } from './relay-pty-source-retirement-capability'
import {
  parsePtyOwnershipTransferDestinationClaimRequest,
  parsePtyOwnershipTransferDestinationProof,
  parsePtyOwnershipTransferDestinationReplayRequest,
  type PtyOwnershipTransferDestinationProof
} from '../shared/pty-ownership-transfer-destination-claim'
import type { PtyOwnershipTransferDestinationClaim } from '../shared/pty-ownership-transfer-destination-claim'
import type { PtyOwnershipTransferWireIdentity } from '../shared/pty-ownership-transfer-wire'
import type { RequestContext } from './dispatcher'
import {
  requireRelayPtyOwnershipTransfer,
  relayPtyOwnershipTransferExecutionVerdict,
  type RelayPtyOwnershipTransferAdapterState,
  type RelayPtyOwnershipTransferRecord
} from './relay-pty-ownership-transfer-adapter-state'
import { persistRelayPtyOwnershipTransfer } from './relay-pty-ownership-transfer-adapter-persistence'
import { readRelayPtyOwnershipTransferJournalFrames } from './relay-pty-ownership-transfer-adapter-operations'

/** Prepared catch-up belongs to the claimed destination, not the desktop source owner. */
export function readRelayPtyOwnershipTransferDestinationReplay(
  state: RelayPtyOwnershipTransferAdapterState,
  value: unknown,
  context: RequestContext
) {
  const request = parsePtyOwnershipTransferDestinationReplayRequest(value)
  const { transfer } = requireDestinationProof(state, request, context)
  if (
    !isRelayPtyOwnershipTransferDestinationClaimActive(
      state,
      request,
      request.destinationClaim,
      context
    )
  ) {
    throw new Error('pty_ownership_transfer_destination_claim_stale')
  }
  const replay = readRelayPtyOwnershipTransferJournalFrames(
    state,
    request,
    transfer.phase === 'committed' ? 'committed' : 'prepared'
  )
  if (request.afterSeq > replay.sourceOutputEndSeq) {
    throw new Error('pty_ownership_transfer_destination_replay_cursor_invalid')
  }
  return replay
}

export function replayRelayPtyOwnershipTransferDestination(
  state: RelayPtyOwnershipTransferAdapterState,
  value: unknown,
  context: RequestContext
) {
  const request = parsePtyOwnershipTransferDestinationReplayRequest(value)
  const replay = readRelayPtyOwnershipTransferDestinationReplay(state, request, context)
  const transfer = requireRelayPtyOwnershipTransfer(state, request)
  if (transfer.destinationOutputRetention) {
    const previous = transfer.destinationDeliveredSeq ?? transfer.destinationAcknowledgedSeq ?? 0
    if (request.afterSeq <= previous) {
      transfer.destinationDeliveredSeq = Math.max(previous, replay.sourceOutputEndSeq)
    }
  }
  return replay
}

/** ACK is the destination's durable receipt, never the relay socket's write completion. */
export function acknowledgeRelayPtyOwnershipTransferDestinationOutput(
  state: RelayPtyOwnershipTransferAdapterState,
  value: unknown,
  context: RequestContext
) {
  const request = parsePtyOwnershipTransferDestinationReplayRequest(value)
  const { transfer } = requireDestinationProof(state, request, context)
  if (
    !transfer.destinationOutputRetention ||
    !isRelayPtyOwnershipTransferDestinationClaimActive(
      state,
      request,
      request.destinationClaim,
      context
    )
  ) {
    throw new Error('pty_ownership_transfer_destination_output_ack_unavailable')
  }
  const acknowledged = transfer.destinationAcknowledgedSeq ?? 0
  if (request.afterSeq > Math.max(acknowledged, transfer.destinationDeliveredSeq ?? 0)) {
    throw new Error('pty_ownership_transfer_destination_output_ack_unsent')
  }
  // Restart conservatively replays every retained frame; only later journal saves evict ACKed data.
  if (request.afterSeq > acknowledged) {
    transfer.destinationOutputRoute?.acknowledge(request.afterSeq)
  }
  transfer.destinationAcknowledgedSeq = Math.max(acknowledged, request.afterSeq)
  state.wakeDestinationOutput?.()
  return Object.freeze({
    ...transfer.identity,
    version: 1 as const,
    acknowledgedThroughSeq: transfer.destinationAcknowledgedSeq
  })
}

/** Authorization, CAS and binding happen synchronously; no request can interleave a newer claim. */
export function claimRelayPtyOwnershipTransferDestination(
  state: RelayPtyOwnershipTransferAdapterState,
  value: unknown,
  context: RequestContext
) {
  const request = parsePtyOwnershipTransferDestinationClaimRequest(value)
  const { binding, transfer } = requireDestinationProof(state, request, context)
  const next = Object.freeze({
    generation: request.destinationGeneration,
    claimId: request.claimId
  })
  if (transfer.destinationClaim?.generation === next.generation) {
    if (!isRelayPtyOwnershipTransferDestinationClaimActive(state, request, next, context)) {
      throw new Error('pty_ownership_transfer_destination_claim_stale')
    }
    return result(transfer, next)
  }
  if ((transfer.destinationClaim?.generation ?? 0) !== request.previousDestinationGeneration) {
    throw new Error('pty_ownership_transfer_destination_claim_stale')
  }
  transfer.destinationClaim = next
  transfer.destinationOutputRoute?.dispose()
  transfer.destinationOutputRoute = undefined
  transfer.destinationDeliveredSeq = undefined
  transfer.destinationClaimBinding = undefined
  try {
    persistRelayPtyOwnershipTransfer(state, transfer)
  } catch (error) {
    // The rename may have succeeded; never resurrect the previous writable connection.
    transfer.destinationDelegationWriteUnverifiable = true
    throw error
  }
  requireAuthenticatedBinding(context)
  transfer.destinationClaimBinding = binding
  return result(transfer, next)
}

/** Reads only established journal state; an uncertain write never becomes a guessed generation. */
export function inspectRelayPtyOwnershipTransferDestination(
  state: RelayPtyOwnershipTransferAdapterState,
  value: unknown,
  context: RequestContext
) {
  const request = parsePtyOwnershipTransferDestinationProof(value)
  const { transfer } = requireDestinationProof(state, request, context, true)
  const executionVerdict = relayPtyOwnershipTransferExecutionVerdict(state, transfer)
  const active =
    !!transfer.destinationClaim &&
    isRelayPtyOwnershipTransferDestinationClaimActive(
      state,
      request,
      transfer.destinationClaim,
      context
    )
  const terminalInfo =
    active && executionVerdict === 'live'
      ? state.options.inspectDestinationTerminal?.(transfer.identity)
      : undefined
  return Object.freeze({
    ...transfer.identity,
    version: 1 as const,
    phase: transfer.phase,
    ...(supportsRelayPtySourceRetirement(state.options)
      ? {
          sourceRetirementVersion: 1 as const,
          sourceRetirementBoundaryVersion: 1 as const,
          sourceRetirementRecoveryVersion: 1 as const
        }
      : {}),
    ...(transfer.surfacePublication
      ? { surfacePublication: structuredClone(transfer.surfacePublication) }
      : {}),
    ...(state.options.enableCaptureImportAcknowledgement &&
    state.options.enableDestinationOutputRetention
      ? { captureImportAckVersion: 1 }
      : {}),
    executionVerdict,
    ...(terminalInfo ? { terminalInfo: Object.freeze({ ...terminalInfo }) } : {}),
    sourceOutputEndSeq: transfer.sourceOutputEndSeq,
    ...(transfer.captureBaseline
      ? { captureBaseline: structuredClone(transfer.captureBaseline) }
      : {}),
    ...(transfer.destinationOutputRetention
      ? { destinationAcknowledgedSeq: transfer.destinationAcknowledgedSeq ?? 0 }
      : {}),
    inputEpoch: transfer.destinationInputEpoch ?? 0,
    ...(executionVerdict === 'exited' ? { exit: Object.freeze({ ...transfer.exit! }) } : {}),
    ...(transfer.commitReceipt ? { receipt: Object.freeze({ ...transfer.commitReceipt }) } : {}),
    destinationClaim: transfer.destinationClaim
      ? Object.freeze({ ...transfer.destinationClaim })
      : null,
    boundToConnection: transfer.destinationClaim
      ? isRelayPtyOwnershipTransferDestinationClaimActive(
          state,
          request,
          transfer.destinationClaim,
          context
        )
      : false
  })
}

/** Re-establishes durability without reloading old output or restarting the PTY-owning relay. */
export function recoverRelayPtyOwnershipTransferDestination(
  state: RelayPtyOwnershipTransferAdapterState,
  value: unknown,
  context: RequestContext
) {
  const request = parsePtyOwnershipTransferDestinationProof(value)
  const { transfer } = requireDestinationProof(state, request, context, true, true)
  if (transfer.destinationDelegationWriteUnverifiable) {
    transfer.destinationClaimBinding = undefined
    persistRelayPtyOwnershipTransfer(state, transfer)
    transfer.destinationDelegationWriteUnverifiable = false
  }
  return inspectRelayPtyOwnershipTransferDestination(state, request, context)
}

export function requireDestinationProof(
  state: RelayPtyOwnershipTransferAdapterState,
  request: PtyOwnershipTransferDestinationProof,
  context: RequestContext,
  allowAborted = false,
  allowUnverifiable = false
) {
  const binding = requireAuthenticatedBinding(context)
  const transfer = requireRelayPtyOwnershipTransfer(state, request)
  requireClaimAvailable(state, transfer, allowAborted, allowUnverifiable)
  const digest = createHash('sha256').update(request.credential).digest()
  if (
    !timingSafeEqual(digest, Buffer.from(transfer.destinationDelegation!.credentialSha256, 'hex'))
  ) {
    throw new Error('pty_ownership_transfer_destination_claim_unauthorized')
  }
  return { binding, transfer }
}

/** Call at the mutation boundary, including after any awaited authorization or control preflight. */
export function isRelayPtyOwnershipTransferDestinationClaimActive(
  state: RelayPtyOwnershipTransferAdapterState,
  identity: PtyOwnershipTransferWireIdentity,
  claim: PtyOwnershipTransferDestinationClaim,
  context: RequestContext
): boolean {
  try {
    const binding = requireAuthenticatedBinding(context)
    const transfer = requireRelayPtyOwnershipTransfer(state, identity)
    requireClaimAvailable(state, transfer)
    return (
      transfer.destinationClaim?.generation === claim.generation &&
      transfer.destinationClaim.claimId === claim.claimId &&
      transfer.destinationClaimBinding?.clientId === binding.clientId &&
      transfer.destinationClaimBinding.transportGeneration === binding.transportGeneration &&
      transfer.destinationClaimBinding.principal === binding.principal
    )
  } catch {
    return false
  }
}

function requireClaimAvailable(
  state: RelayPtyOwnershipTransferAdapterState,
  transfer: RelayPtyOwnershipTransferRecord,
  allowAborted = false,
  allowUnverifiable = false
): void {
  if (
    !state.options.enableDestinationDelegationClaims ||
    !state.options.store ||
    !transfer.destinationDelegation ||
    (transfer.phase !== 'prepared' &&
      !(
        transfer.phase === 'committed' &&
        transfer.destinationOutputRetention &&
        transfer.commitReceipt
      ) &&
      !(allowAborted && transfer.phase === 'aborted')) ||
    (transfer.destinationDelegationWriteUnverifiable && !allowUnverifiable)
  ) {
    throw new Error('pty_ownership_transfer_destination_claim_unavailable')
  }
}

function requireAuthenticatedBinding(context: RequestContext) {
  const identity = context.sessionIdentity
  if (
    context.isStale() ||
    !identity?.authenticated ||
    identity.authenticationKind !== 'endpoint-credential' ||
    !identity.principal.trim() ||
    !Number.isSafeInteger(context.clientId) ||
    context.clientId < 1 ||
    !Number.isSafeInteger(context.transportGeneration) ||
    Number(context.transportGeneration) < 0
  ) {
    throw new Error('pty_ownership_transfer_destination_claim_unauthorized')
  }
  return Object.freeze({
    clientId: context.clientId,
    transportGeneration: Number(context.transportGeneration),
    principal: identity.principal
  })
}

function result(
  transfer: RelayPtyOwnershipTransferRecord,
  claim: PtyOwnershipTransferDestinationClaim
) {
  return Object.freeze({
    ...transfer.identity,
    version: 1 as const,
    destinationGeneration: claim.generation,
    claimId: claim.claimId
  })
}
