import type { PtyOwnershipTransferWireIdentity } from '../shared/pty-ownership-transfer-wire'
import type { RequestContext } from './dispatcher'

export function relayPtyRequestAttachmentBinding(context?: RequestContext) {
  return context
    ? {
        clientId: context.clientId,
        ...(context.transportGeneration === undefined
          ? {}
          : { transportGeneration: context.transportGeneration })
      }
    : undefined
}
import {
  requireRelayPtyOwnershipTransfer,
  type RelayPtyOwnershipTransferAdapterState
} from './relay-pty-ownership-transfer-adapter-state'

/** Check an attachment route without exposing relay state or mutating the transfer. */
export function isRelayPtyOwnershipTransferDestinationAttachmentActive(
  state: RelayPtyOwnershipTransferAdapterState,
  value: PtyOwnershipTransferWireIdentity & { attachmentId: string },
  context?: RequestContext
): boolean {
  try {
    const transfer = requireRelayPtyOwnershipTransfer(state, value)
    if (
      (transfer.phase !== 'committed' && transfer.phase !== 'published') ||
      transfer.attachmentId !== value.attachmentId
    ) {
      return false
    }
    const expectedBinding = transfer.attachmentBinding
    if (!expectedBinding || !context) {
      return expectedBinding === undefined
    }
    return (
      expectedBinding.clientId === context.clientId &&
      (expectedBinding.transportGeneration === undefined ||
        expectedBinding.transportGeneration === context.transportGeneration)
    )
  } catch {
    return false
  }
}
