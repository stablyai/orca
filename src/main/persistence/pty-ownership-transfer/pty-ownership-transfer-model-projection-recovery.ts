import type { PtyOwnershipTransferDestinationSnapshot } from '../../../shared/pty-ownership-transfer-destination-adapter'
import type { PtyOwnershipTransferDestinationOutputOutbox } from './pty-ownership-transfer-destination-output-outbox'
import type { PtyOwnershipTransferDestinationRuntimeOptions } from './pty-ownership-transfer-destination-runtime-contract'

/** The workspace snapshot is a repairable projection of the atomic model/cursor journal. */
export function restorePtyOwnershipModelProjection(
  snapshot: PtyOwnershipTransferDestinationSnapshot,
  outbox: PtyOwnershipTransferDestinationOutputOutbox,
  store: Pick<
    PtyOwnershipTransferDestinationRuntimeOptions['store'],
    'checkpointPtyOwnershipTransferTerminalModel'
  >
): void {
  const model = outbox.loadRestorableModel(snapshot.identity)
  if (!model) {
    return
  }
  if (!('checkpoint' in model) && snapshot.phase !== 'published') {
    return
  }
  if (
    snapshot.phase !== 'published' ||
    !snapshot.surfaceBinding ||
    !snapshot.publicationReceipt ||
    ('checkpoint' in model && snapshot.surfaceBinding.ptyId !== model.checkpoint.ptyId) ||
    !store.checkpointPtyOwnershipTransferTerminalModel
  ) {
    throw new Error('pty_ownership_transfer_model_projection_recovery_unavailable')
  }
  store.checkpointPtyOwnershipTransferTerminalModel({
    identity: snapshot.identity,
    surfaceBinding: snapshot.surfaceBinding,
    publicationReceipt: snapshot.publicationReceipt,
    modelData: `${model.modelData}${model.restoreMetadata?.pendingEscapeTailAnsi ?? ''}`,
    allowEmpty: model.modelData === '' ? true : undefined
  })
}
