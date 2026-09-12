import type {
  PtyOwnershipTransferDestinationClaim,
  PtyOwnershipTransferDestinationProof
} from '../../shared/pty-ownership-transfer-destination-claim'
import type { PtyOwnershipTransferDestinationOutputOutbox } from '../persistence/pty-ownership-transfer/pty-ownership-transfer-destination-output-outbox'
import { digestPtyOwnershipInitialModelSnapshot } from '../persistence/pty-ownership-transfer/pty-ownership-transfer-initial-model-digest'
import { parsePtyOwnershipCaptureImportReceipt } from '../../shared/pty-ownership-capture-import-receipt'
import type { PtyOwnershipTransferRequestOptions } from '../providers/ssh-pty-ownership-transfer-client'
import type { OrcadDelegatedTransferClient } from './orcad-delegated-transfer-client'

/** Runs before subscription; the baseline receipt is always reconstructed from durable model bytes. */
export async function reconcileOrcadInitialModelBaseline(options: {
  proof: PtyOwnershipTransferDestinationProof
  claim: PtyOwnershipTransferDestinationClaim
  outbox: PtyOwnershipTransferDestinationOutputOutbox
  client: Pick<OrcadDelegatedTransferClient, 'status' | 'acknowledgeInitialModel'>
  isActive: () => boolean
  requestOptions?: PtyOwnershipTransferRequestOptions
}) {
  const requireActive = () => {
    if (!options.isActive() || options.requestOptions?.signal?.aborted) {
      throw new Error('orcad_delegated_initial_model_ack_stale')
    }
  }
  requireActive()
  let status = await options.client.status(options.proof, options.requestOptions)
  requireActive()
  const initial = options.outbox.loadInitialModelSnapshot(options.proof)
  if (!initial && !status.captureBaseline) {
    return status
  }
  const receipt = () => {
    requireActive()
    const model = options.outbox.loadInitialModelSnapshot(options.proof)
    const baseline = status.captureBaseline
    if (
      !model ||
      !baseline ||
      status.phase === 'aborted' ||
      !status.boundToConnection ||
      status.destinationClaim?.generation !== options.claim.generation ||
      status.destinationClaim.claimId !== options.claim.claimId ||
      model.throughSeq !== baseline.boundary.throughSeq ||
      options.outbox.load(options.proof)?.baseEndSeq !== model.throughSeq ||
      digestPtyOwnershipInitialModelSnapshot(model, options.proof, model.throughSeq) !==
        baseline.modelSha256
    ) {
      throw new Error('orcad_delegated_initial_model_ack_evidence_mismatch')
    }
    return parsePtyOwnershipCaptureImportReceipt(
      {
        version: 1,
        identity: options.proof,
        throughSeq: model.throughSeq,
        modelSha256: baseline.modelSha256
      },
      options.proof
    )
  }
  const imported = receipt()
  if (status.destinationAcknowledgedSeq === undefined) {
    throw new Error('orcad_delegated_initial_model_ack_cursor_unavailable')
  }
  if (status.destinationAcknowledgedSeq >= imported.throughSeq) {
    return status
  }
  if (status.captureImportAckVersion !== 1) {
    throw new Error('orcad_delegated_initial_model_ack_unsupported')
  }
  await options.client.acknowledgeInitialModel(
    { ...options.proof, destinationClaim: options.claim, receipt: imported },
    options.requestOptions
  )
  receipt()
  status = await options.client.status(options.proof, options.requestOptions)
  if (
    JSON.stringify(receipt()) !== JSON.stringify(imported) ||
    status.destinationAcknowledgedSeq === undefined ||
    status.destinationAcknowledgedSeq < imported.throughSeq
  ) {
    throw new Error('orcad_delegated_initial_model_ack_unverified')
  }
  return status
}
