import type { RelayPtyOwnershipTransferAdapterState } from './relay-pty-ownership-transfer-adapter-state'
import type { PtyOwnershipTransferWireIdentity } from '../shared/pty-ownership-transfer-wire'
import { parsePtyOwnershipCaptureBaseline } from '../shared/pty-ownership-capture-baseline'
import { inspectRelayPtyOwnershipSuccessorCaptureEvidence } from './relay-pty-ownership-transfer-capture-cursor'
import {
  samePtySourceDelivery,
  type PtySourceDeliverySnapshot
} from '../shared/pty-source-credit-contract'

/** Destination durable enqueue custody; source exclusion and actual delivery checks remain separate. */
export function retainRelayPtyCommittedSourceCustody(
  state: RelayPtyOwnershipTransferAdapterState,
  identity: PtyOwnershipTransferWireIdentity,
  savedBaseline: unknown,
  actualDelivery: PtySourceDeliverySnapshot
) {
  const baseline = parsePtyOwnershipCaptureBaseline(savedBaseline, identity)
  const bound = baseline.boundary.identity
  const transfer = state.transfers.get(bound.bridgeId)
  const delivery = Object.freeze({ ...actualDelivery })
  const cutoff = transfer?.committedSourceOutputEndSeq
  const receipt = transfer?.commitReceipt && Object.freeze({ ...transfer.commitReceipt })
  const assertCurrent = (expectedState: RelayPtyOwnershipTransferAdapterState = state) => {
    const coverage = inspectRelayPtyOwnershipSuccessorCaptureEvidence(state, bound, baseline)
    if (
      expectedState !== state ||
      !transfer ||
      !receipt ||
      cutoff === undefined ||
      state.transfers.get(bound.bridgeId) !== transfer ||
      transfer.phase !== 'committed' ||
      !transfer.destinationClaim ||
      transfer.committedSourceOutputEndSeq !== cutoff ||
      JSON.stringify(transfer.commitReceipt) !== JSON.stringify(receipt) ||
      !coverage ||
      coverage.throughSeq !== cutoff ||
      !samePtySourceDelivery(coverage.delivery, delivery) ||
      coverage.delivery.windowSu !== delivery.windowSu ||
      coverage.delivery.receivedEndSu !== delivery.receivedEndSu ||
      delivery.state !== 'active' ||
      delivery.exitPublished ||
      delivery.generationClosed ||
      !Number.isSafeInteger(delivery.sentEndSu) ||
      !Number.isSafeInteger(delivery.creditedEndSu) ||
      delivery.creditedEndSu < baseline.boundary.delivery.creditedEndSu ||
      delivery.sentEndSu < delivery.creditedEndSu ||
      delivery.sentEndSu > delivery.receivedEndSu
    ) {
      throw new Error('pty_committed_source_custody_unavailable')
    }
  }
  assertCurrent()
  return Object.freeze({
    identity: bound,
    modelSha256: baseline.modelSha256,
    sourceOutputEndSeq: cutoff!,
    receipt: receipt!,
    delivery,
    assertCurrent
  })
}
