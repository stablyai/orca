import { parsePtyOwnershipCaptureBaseline } from '../shared/pty-ownership-capture-baseline'
import { parsePtyOwnershipTransferDestinationProof } from '../shared/pty-ownership-transfer-destination-claim'
import type { RequestContext } from './dispatcher'
import { requireDestinationProof } from './relay-pty-ownership-transfer-destination-claim'
import {
  relayPtyOwnershipTransferExecutionVerdict,
  type RelayPtyOwnershipTransferAdapterState
} from './relay-pty-ownership-transfer-adapter-state'
import { readRelayPtyCaptureJournalSuffix } from './relay-pty-capture-journal-suffix'
import { persistRelayPtyOwnershipTransfer } from './relay-pty-ownership-transfer-adapter-persistence'

/** Historical selection uses durable destination proof, never an expired capture token. */
export function recoverRelayPtyOwnershipCaptureSelection(
  state: RelayPtyOwnershipTransferAdapterState,
  proof: unknown,
  value: unknown,
  context: RequestContext
) {
  const request = parsePtyOwnershipTransferDestinationProof(proof)
  const { transfer } = requireDestinationProof(state, request, context)
  const baseline = parsePtyOwnershipCaptureBaseline(value, request)
  if (transfer.captureBaseline) {
    if (JSON.stringify(transfer.captureBaseline) !== JSON.stringify(baseline)) {
      throw new Error('pty_ownership_capture_selection_conflict')
    }
    return transfer.captureBaseline
  }
  if (
    transfer.phase !== 'prepared' ||
    !transfer.destinationOutputRetention ||
    transfer.destinationClaim ||
    transfer.destinationOutputRoute ||
    transfer.exit ||
    transfer.exitObservationPending ||
    relayPtyOwnershipTransferExecutionVerdict(state, transfer) !== 'live' ||
    state.options.hasPendingSourceOutput?.(request.terminalId) ||
    !transfer.issuedCaptureBoundaries?.some(
      (boundary) => JSON.stringify(boundary) === JSON.stringify(baseline.boundary)
    )
  ) {
    throw new Error('pty_ownership_capture_selection_recovery_unavailable')
  }
  const afterSeq = baseline.boundary.throughSeq
  readRelayPtyCaptureJournalSuffix(state, request, afterSeq, transfer.sourceOutputEndSeq)
  transfer.captureBaseline = baseline
  try {
    persistRelayPtyOwnershipTransfer(state, transfer)
  } catch (error) {
    transfer.destinationDelegationWriteUnverifiable = true
    throw error
  }
  return baseline
}
