import { parsePtyOwnershipTransferDestinationProof } from '../../../shared/pty-ownership-transfer-destination-claim'
import { samePtyOwnershipTransferIdentity } from '../../../shared/pty-ownership-transfer-identity'
import type { PtyOwnershipTransferIdentity } from '../../../shared/pty-ownership-transfer-journal'
import type { PtyOwnershipTransferDestinationFileRecord } from './pty-ownership-transfer-destination-file'

export function bindPtyOwnershipTransferDelegatedSource(
  record: PtyOwnershipTransferDestinationFileRecord,
  value: unknown
): PtyOwnershipTransferDestinationFileRecord {
  const delegatedSource = parsePtyOwnershipTransferDelegatedSource(value, record.journal)
  if (
    record.journal.phase === 'aborted' ||
    (record.delegatedSource &&
      JSON.stringify(record.delegatedSource) !== JSON.stringify(delegatedSource))
  ) {
    throw new Error('pty_ownership_transfer_delegated_source_conflict')
  }
  return record.delegatedSource ? record : { ...record, version: 2, delegatedSource }
}

export function parsePtyOwnershipTransferDelegatedSource(
  value: unknown,
  identity: PtyOwnershipTransferIdentity
) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('pty_ownership_transfer_delegated_source_invalid')
  }
  const record = value as Record<string, unknown>
  const proof = parsePtyOwnershipTransferDestinationProof(record.proof)
  if (record.version !== 1 || !samePtyOwnershipTransferIdentity(proof, identity)) {
    throw new Error('pty_ownership_transfer_delegated_source_identity_invalid')
  }
  return Object.freeze({
    version: 1 as const,
    proof,
    endpoint: text(record.endpoint, 4096),
    incumbentVersion: text(record.incumbentVersion, 256),
    endpointCredential: text(record.endpointCredential, 4096)
  })
}

function text(value: unknown, maximum: number): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > maximum ||
    value.includes('\0')
  ) {
    throw new Error('pty_ownership_transfer_delegated_source_invalid')
  }
  return value
}

export type PtyOwnershipTransferDelegatedSource = ReturnType<
  typeof parsePtyOwnershipTransferDelegatedSource
>
