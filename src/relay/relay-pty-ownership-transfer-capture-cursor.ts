import type {
  RelayPtyOwnershipTransferAdapterState,
  RelayPtyOwnershipTransferRecord
} from './relay-pty-ownership-transfer-adapter-state'
import type { PtyOwnershipCaptureBaseline } from '../shared/pty-ownership-capture-baseline'
import type { PtyOwnershipTransferWireIdentity } from '../shared/pty-ownership-transfer-wire'
import { samePtyOwnershipTransferIdentity } from '../shared/pty-ownership-transfer-identity'
import { parsePtyOwnershipCaptureBaseline } from '../shared/pty-ownership-capture-baseline'
import { readRelayPtyCaptureJournalSuffix } from './relay-pty-capture-journal-suffix'
import { parseRelayPtyCommittedSourceCutoff } from './relay-pty-committed-source-cutoff'

/** Journal evidence only; successor authentication and retained ingress are separate requirements. */
export function inspectRelayPtyOwnershipSuccessorCaptureEvidence(
  state: RelayPtyOwnershipTransferAdapterState,
  identity: PtyOwnershipTransferWireIdentity,
  savedBaseline: unknown
) {
  try {
    const baseline = parsePtyOwnershipCaptureBaseline(savedBaseline, identity)
    const transfer = state.transfers.get(identity.bridgeId)
    const history = state.histories.get(identity.terminalId)
    if (
      !state.options.store ||
      !transfer?.destinationDelegation ||
      !transfer.destinationOutputRetention ||
      !samePtyOwnershipTransferIdentity(transfer.identity, identity) ||
      !transfer.captureBaseline ||
      JSON.stringify(parsePtyOwnershipCaptureBaseline(transfer.captureBaseline, identity)) !==
        JSON.stringify(baseline) ||
      state.options.resolveTerminalIncarnation?.(identity.terminalId) !== identity.incarnationId ||
      state.transfers.get(identity.bridgeId) !== transfer ||
      state.transferByTerminal.get(identity.terminalId) !== identity.bridgeId ||
      (transfer.phase !== 'prepared' && transfer.phase !== 'committed') ||
      transfer.destinationDelegationWriteUnverifiable ||
      transfer.exit ||
      transfer.exitObservationPending ||
      !state.options.hasPendingSourceOutput ||
      state.options.hasPendingSourceOutput(identity.terminalId) ||
      !history ||
      !Number.isSafeInteger(transfer.sourceOutputEndSeq) ||
      transfer.sourceOutputEndSeq < baseline.boundary.throughSeq ||
      history.nextSeq - 1 !== transfer.sourceOutputEndSeq ||
      state.transfers.get(identity.bridgeId) !== transfer ||
      state.histories.get(identity.terminalId) !== history
    ) {
      return null
    }
    const cutoff = parseRelayPtyCommittedSourceCutoff(
      transfer.committedSourceOutputEndSeq,
      transfer
    )
    const throughSeq = cutoff ?? transfer.sourceOutputEndSeq
    if (throughSeq < baseline.boundary.throughSeq) {
      return null
    }
    const delivery = deriveRelayPtySuccessorCaptureDelivery(transfer, baseline, throughSeq)
    if (!delivery) {
      return null
    }
    if (
      cutoff === undefined &&
      transfer.rawEmissionCheckpoint &&
      transfer.rawCaptureAnchors?.some(
        (candidate) => JSON.stringify(candidate.boundary) === JSON.stringify(baseline.boundary)
      )
    ) {
      readRelayPtyCaptureJournalSuffix(state, identity, baseline.boundary.throughSeq, throughSeq)
    }
    return Object.freeze({
      version: 1 as const,
      identity: baseline.boundary.identity,
      throughSeq,
      delivery
    })
  } catch {
    return null
  }
}

/** Pure raw coverage expectation; this does not acknowledge or inspect a live delivery. */
export function deriveRelayPtySuccessorCaptureDelivery(
  transfer: Pick<RelayPtyOwnershipTransferRecord, 'rawCaptureAnchors' | 'rawEmissionCheckpoint'>,
  baseline: PtyOwnershipCaptureBaseline,
  throughSeq: number
) {
  if (!Number.isSafeInteger(throughSeq) || throughSeq < baseline.boundary.throughSeq) {
    return null
  }
  const anchor = transfer.rawCaptureAnchors?.find(
    (candidate) => JSON.stringify(candidate.boundary) === JSON.stringify(baseline.boundary)
  )
  if (transfer.rawEmissionCheckpoint && !anchor) {
    return null
  }
  let delivery = baseline.boundary.delivery
  if (anchor && transfer.rawEmissionCheckpoint) {
    const raw = transfer.rawEmissionCheckpoint
    if (
      !raw ||
      raw.pending ||
      raw.rawOriginSu !== anchor.rawOriginSu ||
      raw.rawEndSu < anchor.rawEndSu ||
      raw.journalThroughSeq !== throughSeq
    ) {
      return null
    }
    const endSu = delivery.receivedEndSu + (raw.rawEndSu - anchor.rawEndSu)
    if (!Number.isSafeInteger(endSu)) {
      return null
    }
    delivery = Object.freeze({
      ...delivery,
      receivedEndSu: endSu,
      sentEndSu: endSu,
      creditedEndSu: endSu
    })
  } else if (
    throughSeq !== baseline.boundary.throughSeq ||
    (anchor && anchor.rawOriginSu !== anchor.rawEndSu)
  ) {
    return null
  }
  return delivery
}

/** Journal evidence only; capture must also bind the requesting client and drained ingress. */
export function inspectRelayPtyOwnershipCaptureCursor(
  state: RelayPtyOwnershipTransferAdapterState,
  identity: PtyOwnershipTransferWireIdentity
): number | null {
  const transfer = state.transfers.get(identity.bridgeId)
  if (
    !state.options.store ||
    !transfer ||
    !transfer.destinationDelegation ||
    !transfer.destinationOutputRetention ||
    !samePtyOwnershipTransferIdentity(transfer.identity, identity)
  ) {
    return null
  }
  const source = state.options.resolveSource(identity.terminalId)
  const history = state.histories.get(identity.terminalId)
  if (
    !source ||
    source.terminalId !== identity.terminalId ||
    source.incarnationId !== identity.incarnationId ||
    source.ownerLease !== identity.ownerLease ||
    source.sourceOwnerGeneration !== identity.sourceOwnerGeneration ||
    state.transfers.get(identity.bridgeId) !== transfer ||
    transfer.phase !== 'prepared' ||
    state.transferByTerminal.get(identity.terminalId) !== identity.bridgeId ||
    transfer.destinationDelegationWriteUnverifiable ||
    transfer.exit ||
    transfer.exitObservationPending ||
    state.options.hasPendingSourceOutput?.(identity.terminalId) ||
    !history ||
    !Number.isSafeInteger(transfer.sourceOutputEndSeq) ||
    transfer.sourceOutputEndSeq < 0 ||
    history.nextSeq - 1 !== transfer.sourceOutputEndSeq
  ) {
    return null
  }
  return transfer.sourceOutputEndSeq
}
