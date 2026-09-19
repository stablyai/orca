import {
  parsePtyOwnershipCaptureBoundary,
  type PtyOwnershipCaptureBoundary
} from '../shared/pty-ownership-capture-boundary'
import type { PtyOwnershipTransferWireIdentity } from '../shared/pty-ownership-transfer-wire'
import {
  requireRelayPtyOwnershipTransfer,
  type RelayPtyOwnershipTransferAdapterState
} from './relay-pty-ownership-transfer-adapter-state'
import { persistRelayPtyOwnershipTransfer } from './relay-pty-ownership-transfer-adapter-persistence'
import { inspectRelayPtyOwnershipCaptureCursor } from './relay-pty-ownership-transfer-capture-cursor'
import { MAX_ISSUED_CAPTURE_BOUNDARIES } from './relay-pty-ownership-transfer-capture-journal'

/** Only the host's drained capture inspector may issue historical boundary evidence. */
export function retainRelayPtyOwnershipCaptureBoundary(
  state: RelayPtyOwnershipTransferAdapterState,
  identity: PtyOwnershipTransferWireIdentity,
  value: PtyOwnershipCaptureBoundary,
  rawCursor?: number
): PtyOwnershipCaptureBoundary {
  const boundary = parsePtyOwnershipCaptureBoundary(value, identity)
  const transfer = requireRelayPtyOwnershipTransfer(state, identity)
  const raw = transfer.rawEmissionCheckpoint
  if (
    rawCursor !== undefined &&
    (!Number.isSafeInteger(rawCursor) ||
      rawCursor < 0 ||
      (raw &&
        (raw.pending ||
          raw.rawEndSu !== rawCursor ||
          raw.journalThroughSeq !== boundary.throughSeq)))
  ) {
    throw new Error('pty_ownership_capture_raw_cursor_unavailable')
  }
  if (
    inspectRelayPtyOwnershipCaptureCursor(state, identity) !== boundary.throughSeq ||
    transfer.destinationClaim ||
    transfer.destinationOutputRoute
  ) {
    throw new Error('pty_ownership_capture_boundary_unavailable')
  }
  const issued =
    transfer.issuedCaptureBoundaries ??
    (transfer.captureBaseline ? [transfer.captureBaseline.boundary] : [])
  if (issued.some((entry) => JSON.stringify(entry) === JSON.stringify(boundary))) {
    return boundary
  }
  if (issued.length >= MAX_ISSUED_CAPTURE_BOUNDARIES) {
    throw new Error('pty_ownership_capture_boundary_capacity')
  }
  transfer.issuedCaptureBoundaries = [...issued, boundary]
  if (
    rawCursor !== undefined ||
    (raw && !raw.pending && raw.journalThroughSeq === boundary.throughSeq)
  ) {
    transfer.rawCaptureAnchors = [
      ...(transfer.rawCaptureAnchors ?? []),
      Object.freeze({
        boundary,
        rawOriginSu: raw?.rawOriginSu ?? rawCursor!,
        rawEndSu: raw?.rawEndSu ?? rawCursor!
      })
    ]
  }
  try {
    persistRelayPtyOwnershipTransfer(state, transfer)
  } catch (error) {
    transfer.destinationDelegationWriteUnverifiable = true
    throw error
  }
  return boundary
}
