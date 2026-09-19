import type { PtyOwnershipBridgeCapabilities } from '../../../shared/pty-ownership-bridge-contract'
import { samePtyOwnershipTransferIdentity } from '../../../shared/pty-ownership-transfer-identity'
import type {
  PtyOwnershipTransferOutputFrame,
  PtyOwnershipTransferWireIdentity
} from '../../../shared/pty-ownership-transfer-wire'
import type { PtyOwnershipTransferDestinationAdapter } from '../../../shared/pty-ownership-transfer-destination-adapter'

export type PtyOwnershipTransferDestinationOutputSource = Readonly<{
  onDestinationOutput?: (
    capabilities: PtyOwnershipBridgeCapabilities,
    identity: PtyOwnershipTransferWireIdentity,
    attachmentId: string,
    callback: (event: {
      identity: PtyOwnershipTransferWireIdentity
      attachmentId: string
      frame: PtyOwnershipTransferOutputFrame
    }) => void | Promise<void>
  ) => () => void
}>

/** Attaches a source-runtime output stream to one exact destination attachment. */
export function watchPtyOwnershipTransferDestinationOutput(
  source: PtyOwnershipTransferDestinationOutputSource,
  capabilities: PtyOwnershipBridgeCapabilities,
  identity: PtyOwnershipTransferWireIdentity,
  attachmentId: string,
  adapter: PtyOwnershipTransferDestinationAdapter,
  acceptFrame?: (
    identity: PtyOwnershipTransferWireIdentity,
    frame: PtyOwnershipTransferOutputFrame
  ) => void | Promise<void>
): () => void {
  const onDestinationOutput = source.onDestinationOutput
  if (!onDestinationOutput) {
    return () => {}
  }
  let unsubscribe: (() => void) | undefined
  unsubscribe = onDestinationOutput(capabilities, identity, attachmentId, async (event) => {
    const current = adapter.snapshot()
    if (
      !samePtyOwnershipTransferIdentity(current.identity, event.identity) ||
      event.attachmentId !== attachmentId
    ) {
      throw new Error('pty_ownership_transfer_destination_output_binding_stale')
    }
    await (acceptFrame
      ? acceptFrame(event.identity, event.frame)
      : adapter.acceptPostCommitOutput(event.frame))
  })
  let active = true
  return () => {
    if (!active) {
      return
    }
    active = false
    unsubscribe?.()
    unsubscribe = undefined
  }
}
