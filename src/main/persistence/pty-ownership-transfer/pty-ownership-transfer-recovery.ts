import { randomUUID } from 'node:crypto'
import {
  samePtyOwnershipTransferCommitReceipt,
  samePtyOwnershipTransferPublicationReceipt
} from '../../../shared/pty-ownership-transfer-receipt-validation'
import { PTY_OWNERSHIP_TRANSFER_SURFACE_PUBLICATION_VERSION } from '../../../shared/pty-ownership-transfer-surface-publication'
import {
  PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
  type PtyOwnershipTransferPrepareResult,
  type PtyOwnershipTransferReplayResult,
  type PtyOwnershipTransferStatusRequest
} from '../../../shared/pty-ownership-transfer-wire'
import type {
  PtyOwnershipTransferCoordinatorOptions,
  PtyOwnershipTransferRecoveryResult
} from './pty-ownership-transfer-coordinator'
import type { PtyOwnershipTransferDestinationAdapter } from '../../../shared/pty-ownership-transfer-destination-adapter'
import { attachRecoveredPtyOwnershipTransferSourceRoute } from './pty-ownership-transfer-recovered-source-route'

/** Reconcile a transfer after an ambiguous network response without replaying prepared output. */
export async function recoverPtyOwnershipTransfer(
  options: PtyOwnershipTransferCoordinatorOptions
): Promise<PtyOwnershipTransferRecoveryResult> {
  if (!options.source.status) {
    throw new Error('pty_ownership_transfer_status_unavailable')
  }
  const request: PtyOwnershipTransferStatusRequest = {
    ...options.identity,
    version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION
  }
  const status = await options.source.status(request, requestOptions(options))
  assertTransferIdentity(status, options.identity)

  if (status.phase === 'aborted') {
    return Object.freeze({ source: status, destination: null, published: false })
  }
  if (status.phase !== 'committed' && status.phase !== 'published') {
    return Object.freeze({ source: status, destination: null, published: false })
  }

  const prepared: PtyOwnershipTransferPrepareResult = {
    ...options.identity,
    version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
    phase: 'prepared',
    sourceOutputEndSeq: status.sourceOutputEndSeq,
    replayStartSeq: status.replayStartSeq,
    surfacePublication: {
      version: PTY_OWNERSHIP_TRANSFER_SURFACE_PUBLICATION_VERSION,
      surfaceBinding: options.surfaceBinding
    }
  }
  const destination = options.destination.prepare(prepared).adapter
  const destinationSnapshot = destination.snapshot()
  if (destinationSnapshot.phase !== 'committed' && destinationSnapshot.phase !== 'published') {
    throw new Error('pty_ownership_transfer_recovery_destination_not_committed')
  }
  if (!status.commitReceipt) {
    throw new Error('pty_ownership_transfer_recovery_commit_receipt_missing')
  }
  if (
    destinationSnapshot.commitReceipt &&
    !samePtyOwnershipTransferCommitReceipt(destinationSnapshot.commitReceipt, status.commitReceipt)
  ) {
    throw new Error('pty_ownership_transfer_recovery_commit_receipt_mismatch')
  }

  // Destination-first publication is idempotent. If the original response was lost, retry it.
  const publicationReceipt =
    destinationSnapshot.publicationReceipt ?? status.publicationReceipt ?? destination.publish()
  if (!publicationReceipt) {
    throw new Error('pty_ownership_transfer_recovery_publication_receipt_missing')
  }
  if (
    destinationSnapshot.publicationReceipt &&
    status.publicationReceipt &&
    !samePtyOwnershipTransferPublicationReceipt(
      destinationSnapshot.publicationReceipt,
      status.publicationReceipt
    )
  ) {
    throw new Error('pty_ownership_transfer_recovery_publication_receipt_mismatch')
  }
  const published = await options.source.publish(
    {
      ...options.identity,
      version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
      publicationReceipt
    },
    requestOptions(options)
  )
  assertTransferIdentity(published, options.identity)
  if (
    !samePtyOwnershipTransferPublicationReceipt(published.publicationReceipt, publicationReceipt)
  ) {
    throw new Error('pty_ownership_transfer_publication_receipt_mismatch')
  }

  // A reconnect can leave the durable destination present but detached from the
  // source relay. Re-attach only after publication has converged so the source
  // can never route live output to a destination whose model is not durable.
  await reattachRecoveredDestination(
    options,
    destination,
    status.reconnectGeneration,
    requestOptions(options)
  )
  return Object.freeze({ source: status, destination, published: true })
}

async function reattachRecoveredDestination(
  options: PtyOwnershipTransferCoordinatorOptions,
  destination: PtyOwnershipTransferDestinationAdapter,
  durableReconnectGeneration: number | undefined,
  requestOptions: { signal?: AbortSignal; timeoutMs?: number }
): Promise<void> {
  if (!options.source.attachDestination && !options.source.rekeyReconnect) {
    return
  }
  const capabilities = options.getDestinationCapabilities
    ? await options.getDestinationCapabilities(requestOptions)
    : options.destinationCapabilities
  if (capabilities === undefined) {
    throw new Error('pty_ownership_transfer_recovery_destination_capabilities_unavailable')
  }
  if (!capabilities) {
    throw new Error('pty_ownership_transfer_recovery_destination_capabilities_unavailable')
  }
  if (!capabilities.postCommitReplay) {
    throw new Error('pty_ownership_transfer_recovery_post_commit_replay_unsupported')
  }
  const destinationSnapshot = destination.snapshot()
  if (destinationSnapshot.phase !== 'committed' && destinationSnapshot.phase !== 'published') {
    throw new Error('pty_ownership_transfer_recovery_destination_not_committed')
  }
  const durableLiveOutputEndSeq = destinationSnapshot.liveOutputEndSeq
  const attachmentId = (options.createAttachmentId ?? randomUUID)()
  if (!attachmentId) {
    throw new Error('pty_ownership_transfer_attachment_id_invalid')
  }
  const reservation = destination.reserveExecutionAttachment(attachmentId)
  let disposeExitWatcher: (() => void) | undefined
  let disposeOutputWatcher: (() => void) | undefined
  let disposeTransportLost: (() => void) | undefined
  try {
    disposeExitWatcher = options.source.onDestinationExitForAttachment
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
    disposeOutputWatcher = options.source.onDestinationOutput
      ? options.destination.watchDestinationOutput(
          options.source,
          capabilities,
          options.identity,
          attachmentId,
          destination,
          reservation
        )
      : undefined
    disposeTransportLost = options.source.onDestinationTransportLost
      ? options.source.onDestinationTransportLost(
          capabilities,
          options.identity,
          attachmentId,
          () => {
            destination.markExecutionUnverifiable(attachmentId)
          }
        )
      : undefined
    if (options.source.waitForDestinationStreamReady) {
      await options.source.waitForDestinationStreamReady(
        capabilities,
        options.identity,
        attachmentId
      )
    }
    const result = await attachRecoveredPtyOwnershipTransferSourceRoute(
      options,
      capabilities,
      destinationSnapshot.phase,
      durableReconnectGeneration,
      attachmentId,
      requestOptions
    )
    if (
      result.attachmentId !== attachmentId ||
      result.phase !== destinationSnapshot.phase ||
      result.executionVerdict !== 'live'
    ) {
      throw new Error('pty_ownership_transfer_recovery_attachment_invalid')
    }
    const replay = await options.source.replay(
      {
        ...options.identity,
        version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
        afterSeq: durableLiveOutputEndSeq,
        attachmentId
      },
      requestOptions
    )
    assertPostCommitReplay(
      replay,
      options.identity,
      destinationSnapshot.phase,
      attachmentId,
      durableLiveOutputEndSeq
    )
    for (const frame of replay.frames) {
      destination.acceptPostCommitReplayOutput(frame, reservation)
    }
    if (destination.snapshot().liveOutputEndSeq !== replay.sourceOutputEndSeq) {
      throw new Error('pty_ownership_transfer_recovery_replay_cursor_mismatch')
    }
    options.destination.acceptDestinationAttachment(result, reservation)
    options.destination.replayPendingPostCommitOutput(options.identity)
  } catch (error) {
    disposeExitWatcher?.()
    disposeOutputWatcher?.()
    disposeTransportLost?.()
    const failedAttachment = destination.snapshot()
    if (
      failedAttachment.attachmentId === attachmentId &&
      failedAttachment.executionVerdict !== 'exited'
    ) {
      destination.reserveExecutionAttachment(attachmentId)
    }
    options.destination.rejectPendingPostCommitOutputAdmission(options.identity, error)
    throw error
  }
}

function assertPostCommitReplay(
  replay: PtyOwnershipTransferReplayResult,
  identity: PtyOwnershipTransferCoordinatorOptions['identity'],
  phase: 'committed' | 'published',
  attachmentId: string,
  afterSeq: number
): void {
  assertTransferIdentity(replay, identity)
  if (replay.attachmentId !== attachmentId || replay.phase !== phase) {
    throw new Error('pty_ownership_transfer_recovery_replay_attachment_invalid')
  }
  if (
    replay.replayStartSeq > afterSeq + 1 ||
    replay.sourceOutputEndSeq < afterSeq ||
    replay.frames.length !== replay.sourceOutputEndSeq - afterSeq
  ) {
    throw new Error('pty_ownership_transfer_recovery_replay_cursor_mismatch')
  }
  let expectedSeq = afterSeq + 1
  for (const frame of replay.frames) {
    if (frame.seq !== expectedSeq++ || frame.truncated) {
      throw new Error('pty_ownership_transfer_recovery_replay_frames_invalid')
    }
  }
}

function requestOptions(options: PtyOwnershipTransferCoordinatorOptions): {
  signal?: AbortSignal
  timeoutMs?: number
} {
  return {
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs })
  }
}

function assertTransferIdentity(
  value: {
    bridgeId: string
    terminalId: string
    incarnationId: string
    ownerLease: string
    sourceOwnerGeneration: number
    destinationRuntimeId: string
  },
  expected: PtyOwnershipTransferCoordinatorOptions['identity']
): void {
  if (
    value.bridgeId !== expected.bridgeId ||
    value.terminalId !== expected.terminalId ||
    value.incarnationId !== expected.incarnationId ||
    value.ownerLease !== expected.ownerLease ||
    value.sourceOwnerGeneration !== expected.sourceOwnerGeneration ||
    value.destinationRuntimeId !== expected.destinationRuntimeId
  ) {
    throw new Error('pty_ownership_transfer_response_identity_mismatch')
  }
}
