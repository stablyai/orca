import type { PtyOwnershipTransferPublicationReceipt } from '../../../shared/pty-ownership-transfer-journal-contract'
import type { PtyOwnershipTransferSurfaceBinding } from '../../../shared/pty-ownership-transfer-surface-binding'
import { makeTerminalScrollbackSnapshotRef } from '../../terminal-scrollback-snapshots'

type SnapshotReferenceRequest = {
  surfaceBinding: PtyOwnershipTransferSurfaceBinding
  publicationReceipt: PtyOwnershipTransferPublicationReceipt
}

export function ownershipTransferSurfaceSnapshotRef(request: SnapshotReferenceRequest): string {
  const binding = request.surfaceBinding
  return makeTerminalScrollbackSnapshotRef(
    `${binding.executionHostId}\0${request.publicationReceipt.publicationReceiptId}\0${binding.tabId}`,
    binding.leafId
  )
}

export function ownershipTransferSurfaceModelSnapshotRef(
  request: SnapshotReferenceRequest
): string {
  const binding = request.surfaceBinding
  return makeTerminalScrollbackSnapshotRef(
    `${binding.executionHostId}\0${request.publicationReceipt.publicationReceiptId}\0terminal-model\0${binding.tabId}`,
    binding.leafId
  )
}
