import { serializeObservedEmissions } from './relay-pty-ownership-transfer-journal-output-codec'
import { parseRelayPtyCommittedSourceCutoff } from './relay-pty-committed-source-cutoff'
import { encodeRelayPtyOwnershipCaptureJournal } from './relay-pty-ownership-transfer-capture-journal'
import { serializeDestinationMutationJournals } from './relay-pty-ownership-transfer-journal-destination-serialization'
import { parseRelayPtyRawEmissionCheckpoint } from './relay-pty-raw-emission-checkpoint-codec'
import { parseRelayPtyRawCaptureAnchors } from './relay-pty-raw-capture-anchor'
import type {
  RelayPtyOwnershipTransferRecord,
  RelayPtyOwnershipTransferOutputHistory
} from './relay-pty-ownership-transfer-adapter-state'
import type { RelayPtyOwnershipTransferDurableRecord } from './relay-pty-ownership-transfer-adapter-contract'

export function serializeDurableRecord(
  transfer: RelayPtyOwnershipTransferRecord,
  history: RelayPtyOwnershipTransferOutputHistory,
  replayBytes: number
): RelayPtyOwnershipTransferDurableRecord {
  const observedEmissions = serializeObservedEmissions(transfer, history, replayBytes)
  const committedSourceOutputEndSeq = parseRelayPtyCommittedSourceCutoff(
    transfer.committedSourceOutputEndSeq,
    transfer
  )
  const rawCaptureAnchors = parseRelayPtyRawCaptureAnchors(
    transfer.rawCaptureAnchors,
    transfer.identity,
    transfer.issuedCaptureBoundaries,
    transfer.captureBaseline
  )
  const rawEmissionCheckpoint = parseRelayPtyRawEmissionCheckpoint(
    transfer.rawEmissionCheckpoint,
    transfer.sourceOutputEndSeq
  )
  return {
    ...(committedSourceOutputEndSeq !== undefined ? { committedSourceOutputEndSeq } : {}),
    ...encodeRelayPtyOwnershipCaptureJournal(transfer),
    identity: structuredClone(transfer.identity),
    ...serializeDestinationMutationJournals(transfer),
    ...(transfer.destinationOutputRetention ? { destinationOutputRetention: true as const } : {}),
    ...(transfer.destinationDelegation
      ? { destinationDelegation: structuredClone(transfer.destinationDelegation) }
      : {}),
    ...(transfer.destinationClaim
      ? { destinationClaim: structuredClone(transfer.destinationClaim) }
      : {}),
    phase: transfer.phase,
    sourceOutputEndSeq: transfer.sourceOutputEndSeq,
    ...(rawEmissionCheckpoint ? { rawEmissionCheckpoint } : {}),
    ...(rawCaptureAnchors ? { rawCaptureAnchors } : {}),
    replayStartSeq: transfer.replayStartSeq,
    history: {
      nextSeq: history.nextSeq,
      frames: structuredClone(history.frames)
    },
    ...(observedEmissions.length > 0 ? { observedEmissions } : {}),
    acceptedInputs: [...transfer.acceptedInputIds].map(([inputId, data]) => ({ inputId, data })),
    acceptedControls: [...transfer.acceptedControls].map(
      ([controlId, { serializedControl, outcome }]) => ({
        controlId,
        serializedControl,
        outcome
      })
    ),
    ...(transfer.reconnectRoute
      ? { reconnectRoute: structuredClone(transfer.reconnectRoute) }
      : {}),
    ...(transfer.exit ? { exit: structuredClone(transfer.exit) } : {}),
    ...(transfer.surfacePublication
      ? { surfacePublication: structuredClone(transfer.surfacePublication) }
      : {}),
    ...(transfer.commitReceipt ? { commitReceipt: structuredClone(transfer.commitReceipt) } : {}),
    ...(transfer.publicationReceipt
      ? { publicationReceipt: structuredClone(transfer.publicationReceipt) }
      : {})
  }
}
