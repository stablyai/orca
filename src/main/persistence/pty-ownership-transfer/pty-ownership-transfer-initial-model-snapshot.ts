import { parsePtyOwnershipModelPayload } from './pty-ownership-transfer-model-payload'
import { parsePtyOwnershipTransferWireIdentity } from '../../../shared/pty-ownership-transfer-wire'
import type { PtyOwnershipTransferIdentity } from '../../../shared/pty-ownership-transfer-journal'
import { samePtyOwnershipTransferIdentity } from '../../../shared/pty-ownership-transfer-identity'
import type { PtyOwnershipTransferOutputOutboxRecord } from './pty-ownership-transfer-destination-output-outbox-record'

export type PtyOwnershipInitialModelSnapshot = ReturnType<
  typeof parsePtyOwnershipInitialModelSnapshot
>

export function parsePtyOwnershipInitialModelSnapshot(
  value: unknown,
  expected: PtyOwnershipTransferIdentity,
  baseEndSeq: number
) {
  const payload = parsePtyOwnershipModelPayload(value)
  const record = value as Record<string, unknown>
  const identity = parsePtyOwnershipTransferWireIdentity(record.identity)
  if (
    record.version !== 1 ||
    !samePtyOwnershipTransferIdentity(identity, expected) ||
    !Number.isSafeInteger(record.throughSeq) ||
    Number(record.throughSeq) < 0 ||
    record.throughSeq !== baseEndSeq ||
    !Number.isSafeInteger(record.modelSequenceEnd) ||
    Number(record.modelSequenceEnd) < 0 ||
    !payload.restoreMetadata
  ) {
    throw new Error('pty_ownership_transfer_initial_model_snapshot_invalid')
  }
  return {
    version: 1 as const,
    identity,
    throughSeq: Number(record.throughSeq),
    modelSequenceEnd: Number(record.modelSequenceEnd),
    ...payload,
    restoreMetadata: payload.restoreMetadata
  }
}

export function recordPtyOwnershipInitialModelSnapshot(
  record: PtyOwnershipTransferOutputOutboxRecord,
  value: unknown
): boolean {
  const snapshot = parsePtyOwnershipInitialModelSnapshot(value, record.identity, record.baseEndSeq)
  if (record.initialModelSnapshot) {
    if (JSON.stringify(record.initialModelSnapshot) !== JSON.stringify(snapshot)) {
      throw new Error('pty_ownership_transfer_initial_model_snapshot_conflict')
    }
    return false
  }
  if (
    record.modelSnapshot ||
    record.modelCheckpoints.length ||
    record.acknowledgedEndSeq !== record.baseEndSeq
  ) {
    throw new Error('pty_ownership_transfer_initial_model_snapshot_too_late')
  }
  record.initialModelSnapshot = snapshot
  record.version = 4
  return true
}
