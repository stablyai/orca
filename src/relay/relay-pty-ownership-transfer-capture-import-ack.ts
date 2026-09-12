import { parsePtyOwnershipCaptureImportAcknowledgement } from '../shared/pty-ownership-capture-import-receipt'
import type { RequestContext } from './dispatcher'
import type { RelayPtyOwnershipTransferAdapterState } from './relay-pty-ownership-transfer-adapter-state'
import {
  requireDestinationProof,
  isRelayPtyOwnershipTransferDestinationClaimActive
} from './relay-pty-ownership-transfer-destination-claim'
import { persistRelayPtyOwnershipTransfer } from './relay-pty-ownership-transfer-adapter-persistence'

/** Only a claimed destination's matching durable model receipt can replace a retained prefix. */
export function acknowledgeRelayPtyOwnershipCaptureImport(
  state: RelayPtyOwnershipTransferAdapterState,
  value: unknown,
  context: RequestContext
) {
  const request = parsePtyOwnershipCaptureImportAcknowledgement(value)
  const { transfer } = requireDestinationProof(state, request, context)
  const selected = transfer.captureBaseline
  const history = state.histories.get(request.terminalId)
  if (
    !state.options.enableCaptureImportAcknowledgement ||
    !state.options.enableDestinationOutputRetention ||
    !transfer.destinationOutputRetention ||
    !selected ||
    !history ||
    !isRelayPtyOwnershipTransferDestinationClaimActive(
      state,
      request,
      request.destinationClaim,
      context
    )
  ) {
    throw new Error('pty_ownership_capture_import_ack_unavailable')
  }
  const { throughSeq, modelSha256 } = request.receipt
  if (
    throughSeq !== selected.boundary.throughSeq ||
    modelSha256 !== selected.modelSha256 ||
    throughSeq > history.nextSeq - 1
  ) {
    throw new Error('pty_ownership_capture_import_ack_receipt_mismatch')
  }
  const result = () =>
    Object.freeze({ ...transfer.identity, version: 1 as const, receipt: request.receipt })
  // Restart derives its ACK floor from the first retained frame, not an in-memory ACK counter.
  if ((history.frames[0]?.seq ?? history.nextSeq) - 1 >= throughSeq) {
    return result()
  }
  if (transfer.destinationOutputRoute) {
    throw new Error('pty_ownership_capture_import_ack_route_active')
  }
  history.frames = history.frames.filter((frame) => frame.seq > throughSeq)
  history.retainedBytes = history.frames.reduce(
    (bytes, frame) => bytes + Buffer.byteLength(frame.data, 'utf8'),
    0
  )
  transfer.replayStartSeq = history.frames[0]?.seq ?? history.nextSeq
  transfer.destinationAcknowledgedSeq = Math.max(
    transfer.destinationAcknowledgedSeq ?? 0,
    throughSeq
  )
  try {
    persistRelayPtyOwnershipTransfer(state, transfer)
  } catch (error) {
    // Keep the safe imported prefix decision, but fence claims until uncertain disk state is recovered.
    transfer.destinationDelegationWriteUnverifiable = true
    transfer.destinationClaimBinding = undefined
    throw error
  }
  state.wakeDestinationOutput?.()
  return result()
}
