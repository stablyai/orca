import type { PtyOwnershipBridgeCapabilities } from '../../../shared/pty-ownership-bridge-contract'
import { samePtyOwnershipTransferIdentity } from '../../../shared/pty-ownership-transfer-identity'
import type {
  PtyOwnershipTransferDestinationAttachmentReservation,
  PtyOwnershipTransferDestinationAdapter
} from '../../../shared/pty-ownership-transfer-destination-adapter'
import type {
  PtyOwnershipTransferExitEvent,
  PtyOwnershipTransferWireIdentity
} from '../../../shared/pty-ownership-transfer-wire'
import type { PtyOwnershipTransferDestinationExitAdmission } from './pty-ownership-transfer-destination-exit-admission'

export type PtyOwnershipTransferDestinationExitSource = Readonly<{
  onDestinationExit?: (
    capabilities: PtyOwnershipBridgeCapabilities,
    callback: (event: PtyOwnershipTransferExitEvent) => void
  ) => () => void
  onDestinationExitForAttachment?: (
    capabilities: PtyOwnershipBridgeCapabilities,
    identity: PtyOwnershipTransferWireIdentity,
    attachmentId: string,
    callback: (event: PtyOwnershipTransferExitEvent) => void
  ) => () => void
}>

export function watchPtyOwnershipTransferDestinationExit(
  source: PtyOwnershipTransferDestinationExitSource,
  capabilities: PtyOwnershipBridgeCapabilities,
  identity: PtyOwnershipTransferWireIdentity,
  attachmentId: string,
  adapter: PtyOwnershipTransferDestinationAdapter,
  reservation: PtyOwnershipTransferDestinationAttachmentReservation | undefined,
  exitAdmission: PtyOwnershipTransferDestinationExitAdmission,
  exitListeners: Map<string, () => void>
): () => void {
  const onDestinationExit = source.onDestinationExit
  const onDestinationExitForAttachment = source.onDestinationExitForAttachment
  if (!onDestinationExit && !onDestinationExitForAttachment) {
    return () => {}
  }
  const bridgeId = adapter.snapshot().identity.bridgeId
  exitListeners.get(bridgeId)?.()
  if (reservation) {
    exitAdmission.begin(reservation)
  }
  let unsubscribe: () => void
  try {
    const callback = (event: PtyOwnershipTransferExitEvent): void => {
      try {
        const current = adapter.snapshot()
        if (!samePtyOwnershipTransferIdentity(current.identity, event)) {
          return
        }
        exitAdmission.acceptOrBuffer(adapter, event, reservation)
      } catch (error) {
        // Invalid or stale exit evidence must not turn into destination ownership state.
        console.warn('[pty-ownership-transfer] destination exit evidence rejected', error)
      }
    }
    unsubscribe = onDestinationExitForAttachment
      ? onDestinationExitForAttachment(capabilities, identity, attachmentId, callback)
      : onDestinationExit!(capabilities, callback)
  } catch (error) {
    exitAdmission.cancel(reservation)
    throw error
  }
  let active = true
  const dispose = (): void => {
    if (!active) {
      return
    }
    active = false
    unsubscribe()
    exitAdmission.cancel(reservation)
    if (exitListeners.get(bridgeId) === dispose) {
      exitListeners.delete(bridgeId)
    }
  }
  exitListeners.set(bridgeId, dispose)
  return dispose
}
