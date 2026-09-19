import {
  parsePtyOwnershipTransferDestinationClaim,
  type PtyOwnershipTransferDestinationClaim
} from '../../../shared/pty-ownership-transfer-destination-claim'
import type { PtyOwnershipTransferDestinationFileRecord } from './pty-ownership-transfer-destination-file'

export type PtyOwnershipTransferDelegatedClaimIntent = Readonly<{
  version: 1
  previousClaim: PtyOwnershipTransferDestinationClaim | null
  claim: PtyOwnershipTransferDestinationClaim
}>

export function parsePtyOwnershipTransferDelegatedClaimIntent(
  value: unknown
): PtyOwnershipTransferDelegatedClaimIntent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('pty_ownership_transfer_delegated_claim_intent_invalid')
  }
  const record = value as Record<string, unknown>
  const previousClaim =
    record.previousClaim === null
      ? null
      : parsePtyOwnershipTransferDestinationClaim(record.previousClaim)
  const claim = parsePtyOwnershipTransferDestinationClaim(record.claim)
  if (
    record.version !== 1 ||
    claim.generation !== (previousClaim?.generation ?? 0) + 1 ||
    claim.claimId === previousClaim?.claimId
  ) {
    throw new Error('pty_ownership_transfer_delegated_claim_intent_invalid')
  }
  return Object.freeze({ version: 1, previousClaim, claim })
}

export function sameDelegatedClaim(
  left: PtyOwnershipTransferDestinationClaim | null,
  right: PtyOwnershipTransferDestinationClaim | null
): boolean {
  return left === null
    ? right === null
    : right !== null && left.generation === right.generation && left.claimId === right.claimId
}

export function reservePtyOwnershipTransferDelegatedClaimIntent(
  record: PtyOwnershipTransferDestinationFileRecord,
  expected: unknown,
  value: unknown
): PtyOwnershipTransferDestinationFileRecord {
  const next = parsePtyOwnershipTransferDelegatedClaimIntent(value)
  const prior = expected === null ? null : parsePtyOwnershipTransferDelegatedClaimIntent(expected)
  const current = record.delegatedClaimIntent ?? null
  if (!record.delegatedSource || record.journal.phase === 'aborted') {
    throw new Error('pty_ownership_transfer_delegated_claim_intent_unavailable')
  }
  if (sameIntent(current, next)) {
    return record
  }
  if (
    !sameIntent(current, prior) ||
    !sameDelegatedClaim(next.previousClaim, current?.claim ?? null)
  ) {
    throw new Error('pty_ownership_transfer_delegated_claim_intent_conflict')
  }
  return {
    ...record,
    version: record.version >= 4 ? record.version : 3,
    delegatedClaimIntent: next
  }
}

function sameIntent(
  left: PtyOwnershipTransferDelegatedClaimIntent | null,
  right: PtyOwnershipTransferDelegatedClaimIntent | null
): boolean {
  return left === null
    ? right === null
    : right !== null &&
        sameDelegatedClaim(left.previousClaim, right.previousClaim) &&
        sameDelegatedClaim(left.claim, right.claim)
}
