import type { PtyOwnershipTransferDestinationFileStore } from '../persistence/pty-ownership-transfer/pty-ownership-transfer-destination-file-store'
import type { PtyOwnershipTransferIdentity } from '../../shared/pty-ownership-transfer-journal'
import { parsePtyOwnershipTransferDestinationClaim } from '../../shared/pty-ownership-transfer-destination-claim'
import { samePtyOwnershipTransferCommitReceipt } from '../../shared/pty-ownership-transfer-receipt-validation'
import type { PtyOwnershipTransferRequestOptions } from '../providers/ssh-pty-ownership-transfer-client'
import type { OrcadDelegatedTransferClient } from './orcad-delegated-transfer-client'

/** Caller establishes claim and durable output delivery; recovery never mints a replacement receipt. */
export async function recoverOrcadDelegatedCommit(options: {
  identity: PtyOwnershipTransferIdentity
  store: Pick<PtyOwnershipTransferDestinationFileStore, 'load' | 'loadDelegatedSource'>
  client: Pick<OrcadDelegatedTransferClient, 'status' | 'commit'>
  claim: unknown
  isActive?: () => boolean
  waitForAcknowledgedOutput?: boolean
  requestOptions?: PtyOwnershipTransferRequestOptions
}) {
  const identity = Object.freeze({ ...options.identity })
  const source = options.store.loadDelegatedSource(identity)
  const journal = options.store.load(identity)
  const claim = parsePtyOwnershipTransferDestinationClaim(options.claim)
  if (
    !source ||
    !journal?.receipt ||
    (journal.phase !== 'committed' && journal.phase !== 'published')
  ) {
    throw new Error('orcad_delegated_commit_recovery_receipt_unavailable')
  }
  const receipt = Object.freeze({ ...journal.receipt })
  const assertCurrent = () => {
    options.requestOptions?.signal?.throwIfAborted()
    const current = options.store.load(identity)
    if (
      options.isActive?.() === false ||
      !current?.receipt ||
      (current.phase !== 'committed' && current.phase !== 'published') ||
      !samePtyOwnershipTransferCommitReceipt(current.receipt, receipt)
    ) {
      throw new Error('orcad_delegated_commit_recovery_stale')
    }
  }
  assertCurrent()
  const status = await options.client.status(source.proof, options.requestOptions)
  assertCurrent()
  if (status.phase === 'committed') {
    if (!status.receipt || !samePtyOwnershipTransferCommitReceipt(status.receipt, receipt)) {
      throw new Error('orcad_delegated_commit_recovery_receipt_conflict')
    }
    return Object.freeze({ phase: 'committed' as const, receipt })
  }
  if (
    status.phase !== 'prepared' ||
    !status.boundToConnection ||
    status.destinationClaim?.generation !== claim.generation ||
    status.destinationClaim.claimId !== claim.claimId
  ) {
    throw new Error('orcad_delegated_commit_recovery_claim_unavailable')
  }
  if (
    options.waitForAcknowledgedOutput &&
    status.sourceOutputEndSeq !== undefined &&
    status.destinationAcknowledgedSeq !== undefined &&
    status.destinationAcknowledgedSeq < status.sourceOutputEndSeq
  ) {
    return Object.freeze({ phase: 'pending-output' as const, receipt })
  }
  // Older sources omit ACK status; their commit admission still enforces durable output coverage.
  const committed = await options.client.commit(
    {
      ...source.proof,
      destinationClaim: claim,
      acceptedSourceEndSeq: receipt.acceptedSourceEndSeq,
      receipt
    },
    options.requestOptions
  )
  assertCurrent()
  if (!samePtyOwnershipTransferCommitReceipt(committed.receipt, receipt)) {
    throw new Error('orcad_delegated_commit_recovery_receipt_conflict')
  }
  return Object.freeze({ phase: 'committed' as const, receipt })
}
