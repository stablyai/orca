import { parsePtyOwnershipTransferWireIdentity } from '../../shared/pty-ownership-transfer-wire'
import { parsePtyOwnershipCaptureBoundary } from '../../shared/pty-ownership-capture-boundary'
import { parseOrcadLiveSourceOutputSettlement } from './orcad-live-cleanup-output-evidence'

/** An expected boundary, not fresh host evidence; host must match it before retirement mutation. */
export function createOrcadLiveSourceRetirementDelivery(options: {
  identity: unknown
  captureBoundary: unknown
  settlement: unknown
  providerGeneration: number
}) {
  const settled = parseOrcadLiveSourceOutputSettlement(options.settlement)
  if (settled.providerGeneration !== options.providerGeneration) {
    throw new Error('orcad_live_source_retirement_delivery_unverifiable')
  }
  return reconstructOrcadLiveSourceRetirementDelivery(options)
}

/** Historical expected boundary only; recovery requires fresh authenticated host retirement proof. */
export function reconstructOrcadLiveSourceRetirementDelivery(options: {
  identity: unknown
  captureBoundary: unknown
  settlement: unknown
}) {
  const identity = parsePtyOwnershipTransferWireIdentity(options.identity)
  const { delivery } = parsePtyOwnershipCaptureBoundary(options.captureBoundary, identity)
  const settled = parseOrcadLiveSourceOutputSettlement(options.settlement)
  if (
    settled.id !== delivery.id ||
    settled.ptyIncarnation !== delivery.ptyIncarnation ||
    settled.clientGeneration !== delivery.clientGeneration ||
    settled.ownerGeneration !== delivery.ownerGeneration ||
    settled.deliveryToken !== delivery.deliveryToken ||
    settled.fromSourceEndSu > delivery.creditedEndSu ||
    settled.throughSourceEndSu < delivery.creditedEndSu
  ) {
    throw new Error('orcad_live_source_retirement_delivery_unverifiable')
  }
  // Host provider/window identity comes from capture, never from the client provider generation.
  return Object.freeze({
    ...delivery,
    receivedEndSu: settled.throughSourceEndSu,
    sentEndSu: settled.throughSourceEndSu,
    creditedEndSu: settled.throughSourceEndSu
  })
}
