import { randomUUID } from 'node:crypto'
import type { PtyOwnershipTransferDestinationFileStore } from '../persistence/pty-ownership-transfer/pty-ownership-transfer-destination-file-store'
import {
  sameDelegatedClaim,
  type PtyOwnershipTransferDelegatedClaimIntent
} from '../persistence/pty-ownership-transfer/pty-ownership-transfer-delegated-claim-intent'
import type { PtyOwnershipTransferIdentity } from '../../shared/pty-ownership-transfer-journal'
import { samePtyOwnershipTransferCommitReceipt } from '../../shared/pty-ownership-transfer-receipt-validation'
import type { PtyOwnershipTransferRequestOptions } from '../providers/ssh-pty-ownership-transfer-client'
import type { OrcadDelegatedTransferClient } from './orcad-delegated-transfer-client'

/** Caller owns the single-writer connection lifecycle; uncertain source writes require explicit recovery. */
export async function recoverOrcadDelegatedClaim(options: {
  identity: PtyOwnershipTransferIdentity
  store: Pick<
    PtyOwnershipTransferDestinationFileStore,
    'load' | 'loadDelegatedSource' | 'loadDelegatedClaimIntent' | 'reserveDelegatedClaimIntent'
  >
  client: Pick<OrcadDelegatedTransferClient, 'status' | 'claim'>
  isActive: () => boolean
  createClaimId?: () => string
  requestOptions?: PtyOwnershipTransferRequestOptions
}) {
  const identity = Object.freeze({ ...options.identity })
  const source = options.store.loadDelegatedSource(identity)
  let intent = options.store.loadDelegatedClaimIntent(identity)
  const assertCurrent = () => {
    if (
      !options.isActive() ||
      options.requestOptions?.signal?.aborted ||
      JSON.stringify(options.store.loadDelegatedClaimIntent(identity)) !== JSON.stringify(intent)
    ) {
      throw new Error('orcad_delegated_claim_recovery_stale')
    }
    const journal = options.store.load(identity)
    if (!source || !journal || journal.phase === 'aborted') {
      throw new Error('orcad_delegated_claim_recovery_unavailable')
    }
    return journal
  }
  assertCurrent()
  const status = await options.client.status(source!.proof, options.requestOptions)
  const journal = assertCurrent()
  if (
    status.phase === 'aborted' ||
    (status.receipt &&
      (!journal.receipt || !samePtyOwnershipTransferCommitReceipt(status.receipt, journal.receipt)))
  ) {
    throw new Error('orcad_delegated_claim_recovery_conflict')
  }
  if (intent && sameDelegatedClaim(status.destinationClaim, intent.claim)) {
    if (status.boundToConnection) {
      return intent.claim
    }
    intent = reserve(intent, intent.claim)
  } else if (intent && sameDelegatedClaim(status.destinationClaim, intent.previousClaim)) {
    // An interrupted reservation keeps its original claim ID when the source still has its predecessor.
  } else if (!intent && status.destinationClaim === null) {
    intent = reserve(null, null)
  } else {
    throw new Error('orcad_delegated_claim_recovery_conflict')
  }
  assertCurrent()
  const claimed = await options.client.claim(
    {
      ...source!.proof,
      previousDestinationGeneration: intent.previousClaim?.generation ?? 0,
      destinationGeneration: intent.claim.generation,
      claimId: intent.claim.claimId
    },
    options.requestOptions
  )
  assertCurrent()
  if (
    claimed.destinationGeneration !== intent.claim.generation ||
    claimed.claimId !== intent.claim.claimId
  ) {
    throw new Error('orcad_delegated_claim_recovery_conflict')
  }
  return intent.claim

  function reserve(
    expected: PtyOwnershipTransferDelegatedClaimIntent | null,
    previousClaim: PtyOwnershipTransferDelegatedClaimIntent['previousClaim']
  ) {
    const next = {
      version: 1,
      previousClaim,
      claim: {
        generation: (previousClaim?.generation ?? 0) + 1,
        claimId: (options.createClaimId ?? randomUUID)()
      }
    }
    assertCurrent()
    return options.store.reserveDelegatedClaimIntent(identity, expected, next)
  }
}
