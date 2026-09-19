import { parsePtyOwnershipCaptureBaseline } from '../shared/pty-ownership-capture-baseline'
import {
  parsePtyOwnershipCaptureBoundary,
  type PtyOwnershipCaptureBoundary
} from '../shared/pty-ownership-capture-boundary'
import type { PtyOwnershipTransferWireIdentity } from '../shared/pty-ownership-transfer-wire'
import {
  requireRelayPtyOwnershipTransfer,
  type RelayPtyOwnershipTransferAdapterState
} from './relay-pty-ownership-transfer-adapter-state'
import { inspectRelayPtyOwnershipCaptureCursor } from './relay-pty-ownership-transfer-capture-cursor'
import { persistRelayPtyOwnershipTransfer } from './relay-pty-ownership-transfer-adapter-persistence'

/** Called only with a host-owned capture inspector, never caller-authored authority. */
export function selectRelayPtyOwnershipCaptureBaseline(
  state: RelayPtyOwnershipTransferAdapterState,
  identity: PtyOwnershipTransferWireIdentity,
  value: unknown,
  inspectCapture: () => PtyOwnershipCaptureBoundary | null
) {
  const selected = parsePtyOwnershipCaptureBaseline(value, identity)
  const transfer = requireRelayPtyOwnershipTransfer(state, identity)
  const current = inspectCapture()
  if (
    !current ||
    JSON.stringify(parsePtyOwnershipCaptureBoundary(current, identity)) !==
      JSON.stringify(selected.boundary) ||
    inspectRelayPtyOwnershipCaptureCursor(state, identity) !== selected.boundary.throughSeq ||
    (transfer.issuedCaptureBoundaries &&
      !transfer.issuedCaptureBoundaries.some(
        (boundary) => JSON.stringify(boundary) === JSON.stringify(selected.boundary)
      )) ||
    transfer.destinationClaim ||
    transfer.destinationOutputRoute
  ) {
    throw new Error('pty_ownership_capture_selection_unavailable')
  }
  if (transfer.captureBaseline) {
    if (JSON.stringify(transfer.captureBaseline) !== JSON.stringify(selected)) {
      throw new Error('pty_ownership_capture_selection_conflict')
    }
    return transfer.captureBaseline
  }
  transfer.captureBaseline = selected
  try {
    persistRelayPtyOwnershipTransfer(state, transfer)
  } catch (error) {
    // A successful rename followed by failed fsync must not permit a conflicting selection.
    transfer.destinationDelegationWriteUnverifiable = true
    throw error
  }
  return selected
}
