import { parsePtyOwnershipTransferDestinationCommitRequest } from '../shared/pty-ownership-transfer-destination-claim'
import type { RequestContext } from './dispatcher'
import type { RelayPtyOwnershipTransferAdapterState } from './relay-pty-ownership-transfer-adapter-state'
import {
  requireDestinationProof,
  isRelayPtyOwnershipTransferDestinationClaimActive
} from './relay-pty-ownership-transfer-destination-claim'
import { sameTransferCommitReceipt } from './relay-pty-ownership-transfer-adapter-validation'
import { persistRelayPtyOwnershipTransfer } from './relay-pty-ownership-transfer-adapter-persistence'

export function commitRelayPtyOwnershipTransferDestination(
  state: RelayPtyOwnershipTransferAdapterState,
  value: unknown,
  context: RequestContext
) {
  const request = parsePtyOwnershipTransferDestinationCommitRequest(value)
  const { transfer } = requireDestinationProof(state, request, context)
  if (
    !state.options.enableDestinationDelegationCommit ||
    !state.options.enableDestinationOutputRetention ||
    !state.options.enableDestinationOutputRoutes ||
    !transfer.destinationOutputRetention ||
    !isRelayPtyOwnershipTransferDestinationClaimActive(
      state,
      request,
      request.destinationClaim,
      context
    )
  ) {
    throw new Error('pty_ownership_transfer_destination_commit_unavailable')
  }
  const result = () =>
    Object.freeze({
      ...transfer.identity,
      version: 1 as const,
      phase: 'committed' as const,
      receipt: Object.freeze({ ...transfer.commitReceipt! })
    })
  if (transfer.phase === 'committed') {
    if (
      !transfer.commitReceipt ||
      !sameTransferCommitReceipt(transfer.commitReceipt, request.receipt)
    ) {
      throw new Error('pty_ownership_transfer_destination_commit_receipt_invalid')
    }
    return result()
  }
  if (
    transfer.phase !== 'prepared' ||
    transfer.exit ||
    !state.options.resolveTerminalIncarnation ||
    !state.options.hasPendingSourceOutput ||
    state.options.resolveTerminalIncarnation(request.terminalId) !== request.incarnationId ||
    state.options.hasPendingSourceOutput(request.terminalId) ||
    !transfer.destinationOutputRoute?.isAvailable()
  ) {
    throw new Error('pty_ownership_transfer_destination_commit_source_unverifiable')
  }
  const endSeq = (state.histories.get(request.terminalId)?.nextSeq ?? 1) - 1
  if (
    request.acceptedSourceEndSeq > endSeq ||
    (transfer.captureBaseline !== undefined &&
      request.acceptedSourceEndSeq !== transfer.captureBaseline.boundary.throughSeq) ||
    transfer.destinationAcknowledgedSeq !== endSeq ||
    request.receipt.bridgeId !== transfer.identity.bridgeId ||
    request.receipt.acceptedSourceEndSeq !== request.acceptedSourceEndSeq
  ) {
    throw new Error('pty_ownership_transfer_destination_commit_cursor_invalid')
  }
  // The original receipt may predate catch-up; durable ACK must still cover every current byte.
  transfer.sourceOutputEndSeq = endSeq
  transfer.commitReceipt = Object.freeze({ ...request.receipt })
  transfer.phase = 'committed'
  transfer.committedSourceOutputEndSeq = endSeq
  try {
    persistRelayPtyOwnershipTransfer(state, transfer)
  } catch (error) {
    // The rename may have succeeded; preserve the receipt and fence both writable routes.
    transfer.destinationDelegationWriteUnverifiable = true
    transfer.destinationClaimBinding = undefined
    transfer.destinationOutputRoute?.dispose()
    transfer.destinationOutputRoute = undefined
    throw error
  }
  state.wakeDestinationOutput?.()
  return result()
}
