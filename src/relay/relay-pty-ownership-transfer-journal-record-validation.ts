import {
  parsePtyOwnershipTransferCommitReceipt,
  parsePtyOwnershipTransferPublicationReceipt
} from '../shared/pty-ownership-transfer-wire'
import {
  parseControl,
  parsePtyOwnershipTransferExit,
  type PtyOwnershipTransferExit
} from '../shared/pty-ownership-transfer-control-wire'
import type { RelayPtyOwnershipTransferRecord } from './relay-pty-ownership-transfer-adapter-state'
import type { RelayPtyOwnershipTransferControlRecord } from './relay-pty-ownership-transfer-adapter-contract'
import { PTY_OWNERSHIP_TRANSFER_DESTINATION_MAX_DURABLE_INPUT_BYTES } from '../shared/pty-ownership-transfer-destination-input'

export function durableRecordVersion(transfer: RelayPtyOwnershipTransferRecord) {
  // Older relays must reject delegated records instead of silently restoring source authority.
  if (transfer.destinationControlJournal) {
    return 8
  }
  if (transfer.destinationInputEpoch !== undefined) {
    return 7
  }
  if (transfer.destinationInputJournal) {
    return 6
  }
  if (transfer.destinationOutputRetention) {
    return transfer.phase === 'committed' ? 5 : 4
  }
  if (transfer.destinationClaim) {
    return 3
  }
  return transfer.destinationDelegation ? 2 : 1
}

export function parseDestinationInputs(
  record: Record<string, unknown>,
  maximum: number
): RelayPtyOwnershipTransferRecord['destinationInputs'] {
  if (record.version !== 7 && record.version !== 8 && record.destinationInputEpoch !== undefined) {
    throw invalidJournal()
  }
  if (
    record.version === 7 ||
    (record.version === 8 && record.destinationInputEpoch !== undefined)
  ) {
    positiveSequence(record.destinationInputEpoch)
  }
  if (record.version !== 6 && record.version !== 7 && record.version !== 8) {
    if (record.destinationInputJournal !== undefined || record.destinationInputs !== undefined) {
      throw invalidJournal()
    }
    return undefined
  }
  if (record.destinationInputJournal !== true) {
    throw invalidJournal()
  }
  const value = record.destinationInputs
  if (!Array.isArray(value) || value.length > maximum) {
    throw invalidJournal()
  }
  const inputs: NonNullable<RelayPtyOwnershipTransferRecord['destinationInputs']> = new Map()
  let bytes = 0
  for (const candidate of value) {
    const entry = requireRecord(candidate)
    if (
      typeof entry.inputId !== 'string' ||
      !entry.inputId ||
      entry.inputId.length > 256 ||
      typeof entry.data !== 'string' ||
      (entry.outcome !== 'applied' && entry.outcome !== 'unverifiable') ||
      inputs.has(entry.inputId)
    ) {
      throw invalidJournal()
    }
    bytes += Buffer.byteLength(entry.inputId, 'utf8') + Buffer.byteLength(entry.data, 'utf8')
    if (bytes > PTY_OWNERSHIP_TRANSFER_DESTINATION_MAX_DURABLE_INPUT_BYTES) {
      throw invalidJournal()
    }
    inputs.set(entry.inputId, { data: entry.data, outcome: entry.outcome })
  }
  return inputs
}

export function parseAcceptedControls(
  value: unknown,
  maximum: number
): RelayPtyOwnershipTransferRecord['acceptedControls'] {
  if (value === undefined) {
    return new Map()
  }
  if (!Array.isArray(value) || value.length > maximum) {
    throw invalidJournal()
  }
  const accepted = new Map<string, RelayPtyOwnershipTransferControlRecord>()
  for (const entryValue of value) {
    const entry = requireRecord(entryValue)
    if (
      typeof entry.controlId !== 'string' ||
      entry.controlId.length === 0 ||
      typeof entry.serializedControl !== 'string' ||
      (entry.outcome !== 'applied' && entry.outcome !== 'unverifiable') ||
      accepted.has(entry.controlId)
    ) {
      throw invalidJournal()
    }
    accepted.set(entry.controlId, {
      serializedControl: entry.serializedControl,
      outcome: entry.outcome
    })
  }
  return accepted
}

export function parseDestinationControls(
  record: Record<string, unknown>,
  maximum: number
): RelayPtyOwnershipTransferRecord['destinationControls'] {
  if (record.version !== 8) {
    if (
      record.destinationControlJournal !== undefined ||
      record.destinationControls !== undefined
    ) {
      throw invalidJournal()
    }
    return undefined
  }
  if (record.destinationControlJournal !== true || !Array.isArray(record.destinationControls)) {
    throw invalidJournal()
  }
  const controls = parseAcceptedControls(record.destinationControls, maximum)
  let bytes = 0
  for (const [controlId, { serializedControl }] of controls) {
    bytes += Buffer.byteLength(controlId, 'utf8') + Buffer.byteLength(serializedControl, 'utf8')
    if (
      controlId.length > 256 ||
      bytes > PTY_OWNERSHIP_TRANSFER_DESTINATION_MAX_DURABLE_INPUT_BYTES
    ) {
      throw invalidJournal()
    }
    try {
      parseControl(JSON.parse(serializedControl))
    } catch {
      throw invalidJournal()
    }
  }
  return controls
}

export function parseExit(value: unknown): PtyOwnershipTransferExit | undefined {
  if (value === undefined) {
    return undefined
  }
  try {
    return parsePtyOwnershipTransferExit(value)
  } catch {
    throw invalidJournal()
  }
}

export function parseAcceptedInputs(value: unknown, maximum: number): Map<string, string> {
  if (value === undefined) {
    return new Map()
  }
  if (!Array.isArray(value) || value.length > maximum) {
    throw invalidJournal()
  }
  const accepted = new Map<string, string>()
  for (const entryValue of value) {
    const entry = requireRecord(entryValue)
    if (
      typeof entry.inputId !== 'string' ||
      entry.inputId.length === 0 ||
      typeof entry.data !== 'string' ||
      accepted.has(entry.inputId)
    ) {
      throw invalidJournal()
    }
    accepted.set(entry.inputId, entry.data)
  }
  return accepted
}

export function assertPhaseEvidence(
  phase: RelayPtyOwnershipTransferRecord['phase'],
  identity: RelayPtyOwnershipTransferRecord['identity'],
  sourceOutputEndSeq: number,
  acceptedInputs: ReadonlyMap<string, string>,
  commitReceipt: RelayPtyOwnershipTransferRecord['commitReceipt'],
  publicationReceipt: RelayPtyOwnershipTransferRecord['publicationReceipt']
): void {
  const committed = phase === 'committed' || phase === 'published'
  if (
    committed !== Boolean(commitReceipt) ||
    (phase === 'published') !== Boolean(publicationReceipt) ||
    (!committed && acceptedInputs.size > 0) ||
    (commitReceipt !== undefined &&
      (commitReceipt.bridgeId !== identity.bridgeId ||
        commitReceipt.acceptedSourceEndSeq > sourceOutputEndSeq))
  ) {
    throw invalidJournal()
  }
}

export function optionalCommitReceipt(value: unknown) {
  return value === undefined ? undefined : parsePtyOwnershipTransferCommitReceipt(value)
}

export function assertRetentionEvidence(
  record: Record<string, unknown>,
  acceptedInputs: ReadonlyMap<string, unknown>,
  acceptedControls: ReadonlyMap<string, unknown>,
  observedEmissions: ReadonlyMap<string, unknown>
): void {
  const retained =
    record.version === 4 ||
    record.version === 5 ||
    record.version === 6 ||
    record.version === 7 ||
    record.version === 8
  if (
    retained !== (record.destinationOutputRetention === true) ||
    (!retained && record.destinationOutputRetention !== undefined) ||
    (retained &&
      (record.reconnectRoute !== undefined ||
        record.attachmentId !== undefined ||
        record.attachmentBinding !== undefined ||
        acceptedInputs.size > 0 ||
        acceptedControls.size > 0 ||
        observedEmissions.size > 0))
  ) {
    throw invalidJournal()
  }
}

export function optionalPublicationReceipt(value: unknown) {
  return value === undefined ? undefined : parsePtyOwnershipTransferPublicationReceipt(value)
}

export function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidJournal()
  }
  return value as Record<string, unknown>
}

export function sequence(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw invalidJournal()
  }
  return Number(value)
}

export function positiveSequence(value: unknown): number {
  const parsed = sequence(value)
  if (parsed === 0) {
    throw invalidJournal()
  }
  return parsed
}

export function validPhase(value: unknown): value is RelayPtyOwnershipTransferRecord['phase'] {
  return (
    value === 'prepared' || value === 'committed' || value === 'published' || value === 'aborted'
  )
}

export function invalidJournal(): Error {
  return new Error('pty_ownership_transfer_relay_journal_invalid')
}
