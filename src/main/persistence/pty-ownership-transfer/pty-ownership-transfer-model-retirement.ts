import { parsePtyOwnershipTransferWireIdentity } from '../../../shared/pty-ownership-transfer-wire'
import { samePtyOwnershipTransferIdentity } from '../../../shared/pty-ownership-transfer-identity'
import { parsePtyOwnershipTransferDestinationClaim } from '../../../shared/pty-ownership-transfer-destination-claim'
import { parsePtyOwnershipTransferSurfaceBinding } from '../../../shared/pty-ownership-transfer-surface-binding'
import { parsePtyOwnershipTransferExit } from '../../../shared/pty-ownership-transfer-control-wire'
import type { PtyOwnershipTransferOutputOutboxRecord } from './pty-ownership-transfer-destination-output-outbox-record'

export type PtyOwnershipModelRetirement = ReturnType<typeof parsePtyOwnershipModelRetirement>

export function parsePtyOwnershipModelRetirement(
  value: unknown,
  record: PtyOwnershipTransferOutputOutboxRecord
) {
  const candidate = value as Record<string, unknown> | null
  const event = candidate?.event as Record<string, unknown> | null
  if (!candidate || !event || (candidate.phase !== 'prepared' && candidate.phase !== 'applied')) {
    throw new Error('pty_ownership_transfer_retirement_invalid')
  }
  const identity = parsePtyOwnershipTransferWireIdentity(event.identity)
  const surfaceBinding = parsePtyOwnershipTransferSurfaceBinding(event.surfaceBinding)
  const destinationClaim = parsePtyOwnershipTransferDestinationClaim(event.destinationClaim)
  const exit = parsePtyOwnershipTransferExit(event.exit)
  const saved = record.modelSnapshot
  const throughSeq =
    saved?.checkpoint.frameSeq ?? record.initialModelSnapshot?.throughSeq ?? record.baseEndSeq
  if (
    !samePtyOwnershipTransferIdentity(identity, record.identity) ||
    surfaceBinding.executionHostId !== 'local' ||
    surfaceBinding.ptyId !== identity.terminalId ||
    !Number.isSafeInteger(event.finalOutputSeq) ||
    event.finalOutputSeq !== record.acknowledgedEndSeq ||
    record.frames.length ||
    throughSeq !== record.acknowledgedEndSeq ||
    (saved && saved.checkpoint.fragmentEndSu !== saved.checkpoint.frameLengthSu)
  ) {
    throw new Error('pty_ownership_transfer_retirement_boundary_invalid')
  }
  return {
    phase: candidate.phase,
    event: {
      identity,
      surfaceBinding,
      destinationClaim,
      exit,
      finalOutputSeq: Number(event.finalOutputSeq)
    }
  }
}

export function recordPtyOwnershipModelRetirement(
  record: PtyOwnershipTransferOutputOutboxRecord,
  value: unknown
): boolean {
  const retirement = parsePtyOwnershipModelRetirement(value, record)
  if (record.retirement) {
    if (JSON.stringify(record.retirement.event) !== JSON.stringify(retirement.event)) {
      throw new Error('pty_ownership_transfer_retirement_conflict')
    }
    if (record.retirement.phase === 'applied' || retirement.phase === 'prepared') {
      return false
    }
  } else if (retirement.phase !== 'prepared') {
    throw new Error('pty_ownership_transfer_retirement_not_prepared')
  }
  record.retirement = retirement
  record.version = 6
  return true
}

export function assertPtyOwnershipModelNotRetired(
  record: PtyOwnershipTransferOutputOutboxRecord
): void {
  if (record.retirement) {
    throw new Error('pty_ownership_transfer_model_retired')
  }
}
