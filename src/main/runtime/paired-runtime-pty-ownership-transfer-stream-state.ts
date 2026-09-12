import type { PtyOwnershipTransferExitEvent } from '../../shared/pty-ownership-transfer-control-wire'
import type {
  PtyOwnershipTransferOutputFrame,
  PtyOwnershipTransferWireIdentity
} from '../../shared/pty-ownership-transfer-wire'
import type {
  PairedRuntimePtyOwnershipTransferOutputAcknowledgements,
  PairedRuntimePtyOwnershipTransferSendRequest
} from './paired-runtime-pty-ownership-transfer-output-acknowledgements'

export type PairedRuntimePtyOwnershipTransferSourceStreamState = {
  key: string
  identity: PtyOwnershipTransferWireIdentity
  attachmentId: string
  outputListeners: Set<
    (event: {
      identity: PtyOwnershipTransferWireIdentity
      attachmentId: string
      frame: PtyOwnershipTransferOutputFrame
    }) => void | Promise<void>
  >
  exitListeners: Set<(event: PtyOwnershipTransferExitEvent) => void>
  transportLostListeners: Set<() => void>
  ready: Promise<void>
  resolveReady: () => void
  rejectReady: (error: unknown) => void
  readySettled?: boolean
  closed: boolean
  subscription: Promise<{
    close: () => void
    sendRequest?: PairedRuntimePtyOwnershipTransferSendRequest
  }> | null
  outputCreditNegotiated?: boolean
  outputDeliveryTail: Promise<void>
  acknowledgements: PairedRuntimePtyOwnershipTransferOutputAcknowledgements | null
  outputCursor?: {
    seq: number
    frame: PtyOwnershipTransferOutputFrame
  }
}

export function pairedRuntimePtyOwnershipTransferSourceStreamKey(
  identity: PtyOwnershipTransferWireIdentity,
  attachmentId: string
): string {
  return JSON.stringify({ identity, attachmentId })
}
