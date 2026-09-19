import { randomUUID } from 'node:crypto'
import type { PtyOwnershipTransferDestinationAdapter } from '../../../shared/pty-ownership-transfer-destination-adapter'
import type { PtyOwnershipBridgeCapabilities } from '../../../shared/pty-ownership-bridge-contract'
import { PTY_OWNERSHIP_TRANSFER_WIRE_VERSION } from '../../../shared/pty-ownership-transfer-wire'
import type { PtyOwnershipTransferRequestOptions } from '../../providers/ssh-pty-ownership-transfer-client'
import type { PtyOwnershipTransferCoordinatorOptions } from './pty-ownership-transfer-coordinator-contract'
import { assertTransferIdentity } from './pty-ownership-transfer-response-identity'

export async function attachPtyOwnershipTransferDestination(
  options: PtyOwnershipTransferCoordinatorOptions,
  destination: PtyOwnershipTransferDestinationAdapter,
  capabilities: PtyOwnershipBridgeCapabilities | null | undefined,
  requestOptions: PtyOwnershipTransferRequestOptions
): Promise<
  | Readonly<{
      disposeExit: () => void
      disposeTransportLost: () => void
      isTransportLost: () => boolean
    }>
  | undefined
> {
  if (capabilities === undefined) {
    return undefined
  }
  if (!capabilities || !options.source.attachDestination) {
    throw new Error('pty_ownership_transfer_destination_attachment_unconfigured')
  }
  const attachmentId = (options.createAttachmentId ?? randomUUID)()
  if (!attachmentId) {
    throw new Error('pty_ownership_transfer_attachment_id_invalid')
  }
  const reservation = destination.reserveExecutionAttachment(attachmentId)
  // Subscribe before the remote attach response: the source can exit immediately after
  // attaching, and a notification arriving in that window must be buffered against this
  // single-use reservation rather than lost between response and watcher registration.
  const disposeExitWatcher = options.source.onDestinationExitForAttachment
    ? options.destination.watchDestinationExitForAttachment(
        options.source,
        capabilities,
        options.identity,
        attachmentId,
        destination,
        reservation
      )
    : options.source.onDestinationExit
      ? options.destination.watchDestinationExit(
          options.source,
          capabilities,
          destination,
          reservation
        )
      : undefined
  const disposeOutputWatcher = options.source.onDestinationOutput
    ? options.destination.watchDestinationOutput(
        options.source,
        capabilities,
        options.identity,
        attachmentId,
        destination,
        reservation
      )
    : undefined
  let transportLost = false
  const disposeTransportLost = options.source.onDestinationTransportLost
    ? options.source.onDestinationTransportLost(
        capabilities,
        options.identity,
        attachmentId,
        () => {
          transportLost = true
          try {
            const phase = destination.snapshot().phase
            if (phase === 'committed' || phase === 'published') {
              destination.markExecutionUnverifiable(attachmentId)
            }
          } catch {
            // A stream can fail before attachment is accepted; rollback handles that fence.
          }
        }
      )
    : undefined
  try {
    if (options.source.waitForDestinationStreamReady) {
      await options.source.waitForDestinationStreamReady(
        capabilities,
        options.identity,
        attachmentId
      )
    }
    const result = await options.source.attachDestination(
      {
        ...options.identity,
        version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
        attachmentId
      },
      capabilities,
      requestOptions
    )
    assertTransferIdentity(result, options.identity)
    options.destination.acceptDestinationAttachment(result, reservation)
    return {
      disposeExit: () => {
        disposeExitWatcher?.()
        disposeOutputWatcher?.()
      },
      disposeTransportLost: disposeTransportLost ?? (() => {}),
      isTransportLost: () => transportLost
    }
  } catch (error) {
    disposeExitWatcher?.()
    disposeOutputWatcher?.()
    disposeTransportLost?.()
    throw error
  }
}
