export { prepareRelayPtyOwnershipTransfer } from './relay-pty-ownership-transfer-preparation'
import {
  parsePtyOwnershipTransferCommitRequest,
  parsePtyOwnershipTransferPublishRequest,
  parsePtyOwnershipTransferReplayRequest,
  type PtyOwnershipTransferCommitResult,
  type PtyOwnershipTransferPublishResult,
  type PtyOwnershipTransferReplayResult
} from '../shared/pty-ownership-transfer-wire'
import {
  PTY_OWNERSHIP_TRANSFER_PUBLICATION_RECEIPT_VERSION,
  type PtyOwnershipTransferCommitReceipt,
  type PtyOwnershipTransferPublicationReceipt
} from '../shared/pty-ownership-transfer-journal-contract'
import { samePtyOwnershipTransferSurfaceBinding } from '../shared/pty-ownership-transfer-surface-binding'
import { RelayPtyOwnershipTransferError } from './relay-pty-ownership-transfer-errors'
import {
  requireRelayPtyOwnershipTransfer,
  type RelayPtyOwnershipTransferAdapterState,
  type RelayPtyOwnershipTransferAttachmentBinding,
  type RelayPtyOwnershipTransferRecord
} from './relay-pty-ownership-transfer-adapter-state'
import {
  sameTransferCommitReceipt,
  sameTransferPublicationReceipt
} from './relay-pty-ownership-transfer-adapter-validation'
import { persistRelayPtyOwnershipTransfer } from './relay-pty-ownership-transfer-adapter-persistence'
import { requireAttachedLiveDestination } from './relay-pty-ownership-transfer-control'
import { assertRelayPtyOwnershipTransferLegacyDestination } from './relay-pty-ownership-transfer-source-route-authorization'

export function replayRelayPtyOwnershipTransfer(
  state: RelayPtyOwnershipTransferAdapterState,
  value: unknown,
  binding?: RelayPtyOwnershipTransferAttachmentBinding
): PtyOwnershipTransferReplayResult {
  const result = readRelayPtyOwnershipTransferReplay(state, value, binding)
  const transfer = requireRelayPtyOwnershipTransfer(state, result)
  transfer.sourceOutputEndSeq = result.sourceOutputEndSeq
  transfer.replayStartSeq = result.replayStartSeq
  persistRelayPtyOwnershipTransfer(state, transfer)
  return result
}

export function readRelayPtyOwnershipTransferReplay(
  state: RelayPtyOwnershipTransferAdapterState,
  value: unknown,
  binding?: RelayPtyOwnershipTransferAttachmentBinding
): PtyOwnershipTransferReplayResult {
  const request = parsePtyOwnershipTransferReplayRequest(value)
  const transfer = requireRelayPtyOwnershipTransfer(state, request)
  let phase: PtyOwnershipTransferReplayResult['phase']
  if (transfer.phase === 'committed' || transfer.phase === 'published') {
    phase = transfer.phase
    if (!request.attachmentId) {
      throw new RelayPtyOwnershipTransferError(
        'stale-attachment',
        'post-commit replay requires the current destination attachment'
      )
    }
    requireAttachedLiveDestination(state, transfer, request.attachmentId, binding)
  } else if (transfer.phase === 'prepared' && !request.attachmentId) {
    phase = 'prepared'
  } else {
    throw new RelayPtyOwnershipTransferError(
      'invalid-phase',
      `cannot replay output while transfer is ${transfer.phase}`
    )
  }
  return readRelayPtyOwnershipTransferJournalFrames(state, request, phase)
}

export function readRelayPtyOwnershipTransferJournalFrames(
  state: RelayPtyOwnershipTransferAdapterState,
  value: ReturnType<typeof parsePtyOwnershipTransferReplayRequest>,
  phase: PtyOwnershipTransferReplayResult['phase']
): PtyOwnershipTransferReplayResult {
  const request = parsePtyOwnershipTransferReplayRequest(value)
  const history = state.histories.get(request.terminalId)
  const firstSeq = history?.frames[0]?.seq ?? history?.nextSeq ?? 1
  if (request.afterSeq < firstSeq - 1) {
    throw new RelayPtyOwnershipTransferError(
      'replay-unavailable',
      `replay before sequence ${firstSeq} is no longer retained`
    )
  }
  const frames = (history?.frames ?? []).filter((frame) => frame.seq > request.afterSeq)
  if (frames.some((frame) => frame.truncated)) {
    throw new RelayPtyOwnershipTransferError(
      'replay-unavailable',
      'the requested output checkpoint is not losslessly retained'
    )
  }
  return Object.freeze({
    ...request,
    phase,
    frames: Object.freeze(frames.map((frame) => Object.freeze({ ...frame }))),
    sourceOutputEndSeq: history?.nextSeq ? history.nextSeq - 1 : 0,
    replayStartSeq: firstSeq,
    ...(request.attachmentId ? { attachmentId: request.attachmentId } : {})
  })
}

export function commitRelayPtyOwnershipTransfer(
  state: RelayPtyOwnershipTransferAdapterState,
  value: unknown
): PtyOwnershipTransferCommitResult {
  const request = parsePtyOwnershipTransferCommitRequest(value)
  const transfer = requireRelayPtyOwnershipTransfer(state, request)
  if (transfer.destinationDelegation) {
    throw new Error('pty_ownership_transfer_destination_delegation_commit_unavailable')
  }
  if (transfer.phase === 'committed' || transfer.phase === 'published') {
    assertCommitReceipt(transfer, request.receipt)
    return Object.freeze({
      ...request,
      phase: 'committed',
      receipt: Object.freeze({ ...transfer.commitReceipt! })
    })
  }
  if (transfer.phase !== 'prepared') {
    throw new RelayPtyOwnershipTransferError(
      'invalid-phase',
      `cannot commit transfer in ${transfer.phase}`
    )
  }
  if (state.options.hasPendingSourceOutput?.(request.terminalId)) {
    throw new RelayPtyOwnershipTransferError(
      'destination-not-caught-up',
      'source output is still awaiting durable observation'
    )
  }
  const history = state.histories.get(request.terminalId)
  const sourceOutputEndSeq = history?.nextSeq ? history.nextSeq - 1 : 0
  const previousSourceOutputEndSeq = transfer.sourceOutputEndSeq
  transfer.sourceOutputEndSeq = sourceOutputEndSeq
  if (request.acceptedSourceEndSeq !== sourceOutputEndSeq) {
    throw new RelayPtyOwnershipTransferError(
      'destination-not-caught-up',
      `destination ends at ${request.acceptedSourceEndSeq}, source ends at ${sourceOutputEndSeq}`
    )
  }
  assertCommitReceipt(transfer, request.receipt)
  transfer.commitReceipt = Object.freeze({ ...request.receipt })
  transfer.phase = 'committed'
  try {
    persistRelayPtyOwnershipTransfer(state, transfer)
  } catch (error) {
    transfer.commitReceipt = undefined
    transfer.phase = 'prepared'
    transfer.sourceOutputEndSeq = previousSourceOutputEndSeq
    throw error
  }
  state.options.onCommitted?.(transfer.identity)
  return Object.freeze({
    ...request,
    phase: 'committed',
    receipt: Object.freeze({ ...transfer.commitReceipt })
  })
}

export function publishRelayPtyOwnershipTransfer(
  state: RelayPtyOwnershipTransferAdapterState,
  value: unknown
): PtyOwnershipTransferPublishResult {
  const request = parsePtyOwnershipTransferPublishRequest(value)
  const transfer = requireRelayPtyOwnershipTransfer(state, request)
  assertRelayPtyOwnershipTransferLegacyDestination(transfer)
  if (transfer.phase === 'published') {
    assertPublicationReceipt(transfer, request.publicationReceipt)
    return Object.freeze({
      ...request,
      phase: 'published',
      publicationReceipt: Object.freeze({ ...transfer.publicationReceipt! })
    })
  }
  if (transfer.phase !== 'committed' || !transfer.commitReceipt) {
    throw new RelayPtyOwnershipTransferError(
      'invalid-phase',
      'destination publication requires a committed transfer'
    )
  }
  assertPublicationReceipt(transfer, request.publicationReceipt)
  transfer.publicationReceipt = Object.freeze({ ...request.publicationReceipt })
  transfer.phase = 'published'
  try {
    persistRelayPtyOwnershipTransfer(state, transfer)
  } catch (error) {
    transfer.publicationReceipt = undefined
    transfer.phase = 'committed'
    throw error
  }
  state.options.onPublished?.(transfer.identity)
  return Object.freeze({
    ...request,
    phase: 'published',
    publicationReceipt: Object.freeze({ ...transfer.publicationReceipt })
  })
}

function assertCommitReceipt(
  transfer: RelayPtyOwnershipTransferRecord,
  receipt: PtyOwnershipTransferCommitReceipt
): void {
  if (
    receipt.bridgeId !== transfer.identity.bridgeId ||
    receipt.acceptedSourceEndSeq !== transfer.sourceOutputEndSeq ||
    !receipt.receiptId ||
    !Number.isFinite(Date.parse(receipt.committedAt)) ||
    (transfer.commitReceipt !== undefined &&
      !sameTransferCommitReceipt(transfer.commitReceipt, receipt))
  ) {
    throw new RelayPtyOwnershipTransferError(
      'receipt-invalid',
      'commit receipt does not prove this bridge and source cursor'
    )
  }
}

function assertPublicationReceipt(
  transfer: RelayPtyOwnershipTransferRecord,
  receipt: PtyOwnershipTransferPublicationReceipt
): void {
  if (
    receipt.version !== PTY_OWNERSHIP_TRANSFER_PUBLICATION_RECEIPT_VERSION ||
    receipt.bridgeId !== transfer.identity.bridgeId ||
    receipt.destinationRuntimeId !== transfer.identity.destinationRuntimeId ||
    !receipt.publicationReceiptId ||
    !Number.isFinite(Date.parse(receipt.publishedAt)) ||
    !transfer.commitReceipt ||
    !sameTransferCommitReceipt(receipt.commitReceipt, transfer.commitReceipt) ||
    (transfer.surfacePublication !== undefined &&
      !samePtyOwnershipTransferSurfaceBinding(
        receipt.surfaceBinding,
        transfer.surfacePublication.surfaceBinding
      )) ||
    (transfer.publicationReceipt !== undefined &&
      !sameTransferPublicationReceipt(transfer.publicationReceipt, receipt))
  ) {
    throw new RelayPtyOwnershipTransferError(
      'receipt-invalid',
      'publication receipt does not prove the committed destination'
    )
  }
}
