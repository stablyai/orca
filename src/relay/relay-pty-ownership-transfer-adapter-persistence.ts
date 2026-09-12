import { parseRelayPtyCommittedSourceCutoff } from './relay-pty-committed-source-cutoff'
import {
  parseObservedEmissions,
  parseHistory
} from './relay-pty-ownership-transfer-journal-output-codec'
import { decodeRelayPtyOwnershipCaptureJournal } from './relay-pty-ownership-transfer-capture-journal'
import {
  parseAcceptedControls,
  parseExit,
  parseAcceptedInputs,
  parseDestinationInputs,
  parseDestinationControls,
  assertPhaseEvidence,
  assertRetentionEvidence,
  optionalCommitReceipt,
  optionalPublicationReceipt,
  sequence,
  positiveSequence,
  validPhase,
  invalidJournal
} from './relay-pty-ownership-transfer-journal-record-validation'
import { PTY_OWNERSHIP_TRANSFER_PUBLICATION_RECEIPT_VERSION } from '../shared/pty-ownership-transfer-journal-contract'
import { parsePtyOwnershipTransferWireIdentity } from '../shared/pty-ownership-transfer-wire'
import { parseOptionalPtyOwnershipTransferSurfacePublication } from '../shared/pty-ownership-transfer-surface-publication'
import { parseOptionalPtyOwnershipTransferDestinationDelegation } from '../shared/pty-ownership-transfer-destination-delegation'
import { parsePtyOwnershipTransferDestinationClaim } from '../shared/pty-ownership-transfer-destination-claim'
import { publicationReceiptMatchesPtyOwnershipTransfer } from '../shared/pty-ownership-transfer-receipt-validation'
import { samePtyOwnershipTransferSurfaceBinding } from '../shared/pty-ownership-transfer-surface-binding'
import type {
  RelayPtyOwnershipTransferAdapterState,
  RelayPtyOwnershipTransferOutputHistory,
  RelayPtyOwnershipTransferRecord
} from './relay-pty-ownership-transfer-adapter-state'
import { parseRelayPtyOwnershipTransferReconnectRoute } from './relay-pty-ownership-transfer-reconnect-route'
import { serializeDurableRecord } from './relay-pty-ownership-transfer-record-serialization'
import { restoreRelayPtyOwnershipTransferRecords } from './relay-pty-ownership-transfer-restoration'
import { parseRelayPtyRawEmissionCheckpoint } from './relay-pty-raw-emission-checkpoint-codec'
import { parseRelayPtyRawCaptureAnchors } from './relay-pty-raw-capture-anchor'
import {
  decodeRelayPtySourceRetirementJournal,
  encodeRelayPtySourceRetirementJournal
} from './relay-pty-source-retirement-journal'

const DURABLE_RECORD_VERSION = 1

export function restoreRelayPtyOwnershipTransferState(
  state: RelayPtyOwnershipTransferAdapterState
): void {
  restoreRelayPtyOwnershipTransferRecords(state, parseDurableRecord)
}

export function persistRelayPtyOwnershipTransfer(
  state: RelayPtyOwnershipTransferAdapterState,
  transfer: RelayPtyOwnershipTransferRecord
): void {
  const store = state.options.store
  if (!store) {
    return
  }
  const history = state.histories.get(transfer.identity.terminalId)
  if (!history) {
    throw invalidJournal()
  }
  store.save(
    encodeRelayPtySourceRetirementJournal(
      serializeDurableRecord(transfer, history, state.replayBytes),
      transfer.sourceDeliveryRetirement,
      transfer.coveredSourceDeliveryRetirement
    )
  )
}

export function removePersistedRelayPtyOwnershipTransfer(
  state: RelayPtyOwnershipTransferAdapterState,
  bridgeId: string
): void {
  state.options.store?.remove(bridgeId)
}

function parseDurableRecord(
  value: unknown,
  replayBytes: number,
  inputIds: number
): Readonly<{
  transfer: RelayPtyOwnershipTransferRecord
  history: RelayPtyOwnershipTransferOutputHistory
}> {
  const retirement = decodeRelayPtySourceRetirementJournal(value)
  const { record, captureBaseline, issuedCaptureBoundaries } =
    decodeRelayPtyOwnershipCaptureJournal(retirement.record)
  if (
    (record.version !== DURABLE_RECORD_VERSION &&
      record.version !== 2 &&
      record.version !== 3 &&
      record.version !== 4 &&
      record.version !== 5 &&
      record.version !== 6 &&
      record.version !== 7 &&
      record.version !== 8) ||
    !validPhase(record.phase)
  ) {
    throw invalidJournal()
  }
  let identity
  try {
    identity = parsePtyOwnershipTransferWireIdentity(record.identity)
  } catch (error) {
    throw new Error('pty_ownership_transfer_relay_journal_invalid', { cause: error })
  }
  const sourceOutputEndSeq = sequence(record.sourceOutputEndSeq)
  const rawCaptureAnchors = parseRelayPtyRawCaptureAnchors(
    record.rawCaptureAnchors,
    identity,
    issuedCaptureBoundaries,
    captureBaseline
  )
  const rawEmissionCheckpoint = parseRelayPtyRawEmissionCheckpoint(
    record.rawEmissionCheckpoint,
    sourceOutputEndSeq
  )
  const replayStartSeq = positiveSequence(record.replayStartSeq)
  const history = parseHistory(record.history, replayBytes)
  if (
    sourceOutputEndSeq !== history.nextSeq - 1 ||
    replayStartSeq !== (history.frames[0]?.seq ?? history.nextSeq)
  ) {
    throw invalidJournal()
  }
  const acceptedInputIds = parseAcceptedInputs(record.acceptedInputs, inputIds)
  const destinationInputs = parseDestinationInputs(record, inputIds)
  const destinationControls = parseDestinationControls(record, inputIds)
  const acceptedControls = parseAcceptedControls(record.acceptedControls, inputIds)
  const reconnectRoute = parseRelayPtyOwnershipTransferReconnectRoute(
    record.reconnectRoute,
    identity
  )
  const observedEmissions = parseObservedEmissions(
    record.observedEmissions,
    history,
    identity,
    replayBytes
  )
  const exit = parseExit(record.exit)
  let surfacePublication
  let destinationDelegation
  let destinationClaim
  let commitReceipt
  let publicationReceipt
  try {
    surfacePublication = parseOptionalPtyOwnershipTransferSurfacePublication(
      record.surfacePublication
    )
    destinationDelegation = parseOptionalPtyOwnershipTransferDestinationDelegation(
      record.destinationDelegation,
      surfacePublication
    )
    if (
      (record.version !== 1) !== Boolean(destinationDelegation) ||
      (destinationDelegation &&
        (surfacePublication?.surfaceBinding.executionHostId !== 'local' ||
          (record.version === 5 ||
          record.version === 6 ||
          record.version === 7 ||
          record.version === 8
            ? record.phase !== 'committed'
            : record.phase !== 'prepared' && record.phase !== 'aborted')))
    ) {
      throw invalidJournal()
    }
    destinationClaim =
      record.destinationClaim === undefined
        ? undefined
        : parsePtyOwnershipTransferDestinationClaim(record.destinationClaim)
    if (
      record.version !== 4 &&
      (record.version === 3 ||
        record.version === 5 ||
        record.version === 6 ||
        record.version === 7 ||
        record.version === 8) !== Boolean(destinationClaim)
    ) {
      throw invalidJournal()
    }
    assertRetentionEvidence(record, acceptedInputIds, acceptedControls, observedEmissions)
    commitReceipt = optionalCommitReceipt(record.commitReceipt)
    publicationReceipt = optionalPublicationReceipt(record.publicationReceipt)
  } catch (error) {
    throw new Error('pty_ownership_transfer_relay_journal_invalid', { cause: error })
  }
  assertPhaseEvidence(
    record.phase,
    identity,
    sourceOutputEndSeq,
    acceptedInputIds,
    commitReceipt,
    publicationReceipt
  )
  if (
    publicationReceipt &&
    (!commitReceipt ||
      publicationReceipt.version !== PTY_OWNERSHIP_TRANSFER_PUBLICATION_RECEIPT_VERSION ||
      !publicationReceiptMatchesPtyOwnershipTransfer(publicationReceipt, identity, commitReceipt))
  ) {
    throw invalidJournal()
  }
  if (
    surfacePublication &&
    publicationReceipt &&
    !samePtyOwnershipTransferSurfaceBinding(
      surfacePublication.surfaceBinding,
      publicationReceipt.surfaceBinding
    )
  ) {
    throw invalidJournal()
  }
  return {
    transfer: {
      committedSourceOutputEndSeq: parseRelayPtyCommittedSourceCutoff(
        record.committedSourceOutputEndSeq,
        {
          phase: record.phase,
          destinationDelegation,
          destinationOutputRetention: record.destinationOutputRetention,
          sourceOutputEndSeq,
          commitReceipt
        }
      ),
      identity: Object.freeze(identity),
      ...(retirement.coveredSourceDeliveryRetirement
        ? { coveredSourceDeliveryRetirement: retirement.coveredSourceDeliveryRetirement }
        : {}),
      ...(retirement.sourceDeliveryRetirement
        ? { sourceDeliveryRetirement: retirement.sourceDeliveryRetirement }
        : {}),
      ...(captureBaseline ? { captureBaseline } : {}),
      ...(issuedCaptureBoundaries ? { issuedCaptureBoundaries } : {}),
      phase: record.phase,
      sourceOutputEndSeq,
      ...(rawEmissionCheckpoint ? { rawEmissionCheckpoint } : {}),
      ...(rawCaptureAnchors ? { rawCaptureAnchors } : {}),
      replayStartSeq,
      acceptedInputIds,
      acceptedControls,
      observedEmissions,
      ...(reconnectRoute ? { reconnectRoute } : {}),
      ...(exit ? { exit } : {}),
      ...(surfacePublication ? { surfacePublication } : {}),
      ...(destinationDelegation ? { destinationDelegation } : {}),
      ...(destinationClaim ? { destinationClaim } : {}),
      ...(destinationInputs ? { destinationInputJournal: true as const, destinationInputs } : {}),
      ...(destinationControls
        ? { destinationControlJournal: true as const, destinationControls }
        : {}),
      ...(record.destinationInputEpoch !== undefined
        ? { destinationInputEpoch: positiveSequence(record.destinationInputEpoch) }
        : {}),
      ...(record.version === 4 ||
      record.version === 5 ||
      record.version === 6 ||
      record.version === 7 ||
      record.version === 8
        ? {
            destinationOutputRetention: true as const,
            destinationAcknowledgedSeq: (history.frames[0]?.seq ?? history.nextSeq) - 1
          }
        : {}),
      ...(commitReceipt ? { commitReceipt } : {}),
      ...(publicationReceipt ? { publicationReceipt } : {})
    },
    history
  }
}
