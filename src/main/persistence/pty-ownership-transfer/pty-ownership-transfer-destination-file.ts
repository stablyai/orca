import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import {
  parseDelegatedInputState,
  type DelegatedInputState
} from './pty-ownership-transfer-delegated-input-state'
import {
  parsePtyOwnershipTransferDelegatedClaimIntent,
  type PtyOwnershipTransferDelegatedClaimIntent
} from './pty-ownership-transfer-delegated-claim-intent'
import {
  parsePtyOwnershipTransferDelegatedSource,
  type PtyOwnershipTransferDelegatedSource
} from './pty-ownership-transfer-delegated-source'
import {
  parsePtyOwnershipTransferJournal,
  parsePtyOwnershipTransferPublicationReceipt,
  type PtyOwnershipTransferPublicationReceipt,
  type PtyOwnershipTransferDestinationJournal
} from '../../../shared/pty-ownership-transfer-journal'
import { samePtyOwnershipTransferPublicationReceipt } from '../../../shared/pty-ownership-transfer-receipt-validation'
import {
  parsePtyOwnershipTransferSurfaceBinding,
  samePtyOwnershipTransferSurfaceBinding,
  type PtyOwnershipTransferSurfaceBinding
} from '../../../shared/pty-ownership-transfer-surface-binding'
import {
  PTY_OWNERSHIP_TRANSFER_DESTINATION_MAX_FRAME_BYTES,
  PTY_OWNERSHIP_TRANSFER_DESTINATION_MAX_STAGED_BYTES
} from '../../../shared/pty-ownership-transfer-destination-adapter'
import type { PtyOwnershipTransferOutputFrame } from '../../../shared/pty-ownership-transfer-wire'
import { samePtyOwnershipTransferIdentity } from '../../../shared/pty-ownership-transfer-identity'
import {
  parseOrcadTerminalLayoutAdmission,
  type OrcadTerminalLayoutAdmission
} from '../migrating-orcad-catalog/orcad-terminal-layout-admission'

export const PTY_OWNERSHIP_TRANSFER_DESTINATION_FILE_VERSION = 1 as const
export const PTY_OWNERSHIP_TRANSFER_DESTINATION_FILE_MAX_BYTES = 64 * 1024 * 1024
import { PTY_OWNERSHIP_TRANSFER_DESTINATION_MAX_DURABLE_INPUT_BYTES } from '../../../shared/pty-ownership-transfer-destination-input'
export { PTY_OWNERSHIP_TRANSFER_DESTINATION_MAX_DURABLE_INPUT_BYTES } from '../../../shared/pty-ownership-transfer-destination-input'
export const PTY_OWNERSHIP_TRANSFER_DESTINATION_MAX_DURABLE_FRAMES = 65_536

export type PtyOwnershipTransferDestinationFileRecord = {
  version: typeof PTY_OWNERSHIP_TRANSFER_DESTINATION_FILE_VERSION | 2 | 3 | 4 | 5
  catalogAdmission?: OrcadTerminalLayoutAdmission
  delegatedInputs?: DelegatedInputState
  delegatedSource?: PtyOwnershipTransferDelegatedSource
  delegatedClaimIntent?: PtyOwnershipTransferDelegatedClaimIntent
  journal: PtyOwnershipTransferDestinationJournal
  frames: PtyOwnershipTransferOutputFrame[]
  inputIds: { inputId: string; data: string }[]
  surfaceBinding?: PtyOwnershipTransferSurfaceBinding
  publicationIntent?: PtyOwnershipTransferPublicationReceipt
}

export function readPtyOwnershipTransferDestinationFile(filePath: string): unknown {
  const descriptor = openSync(filePath, 'r')
  try {
    const size = fstatSync(descriptor).size
    if (
      !Number.isSafeInteger(size) ||
      size <= 0 ||
      size > PTY_OWNERSHIP_TRANSFER_DESTINATION_FILE_MAX_BYTES
    ) {
      throw new Error('pty_ownership_transfer_destination_file_size_invalid')
    }
    const contents = Buffer.allocUnsafe(size)
    let offset = 0
    while (offset < size) {
      const bytesRead = readSync(descriptor, contents, offset, size - offset, null)
      if (bytesRead === 0) {
        throw new Error('pty_ownership_transfer_destination_file_truncated')
      }
      offset += bytesRead
    }
    if (readSync(descriptor, Buffer.allocUnsafe(1), 0, 1, null) !== 0) {
      throw new Error('pty_ownership_transfer_destination_file_changed')
    }
    return JSON.parse(contents.toString('utf8')) as unknown
  } finally {
    closeSync(descriptor)
  }
}

export function parsePtyOwnershipTransferDestinationFile(
  value: unknown,
  maxInputIds: number
): PtyOwnershipTransferDestinationFileRecord {
  if (
    !isRecord(value) ||
    (value.version !== PTY_OWNERSHIP_TRANSFER_DESTINATION_FILE_VERSION &&
      value.version !== 2 &&
      value.version !== 3 &&
      value.version !== 4 &&
      value.version !== 5)
  ) {
    throw new Error('pty_ownership_transfer_destination_file_invalid')
  }
  const journal = parsePtyOwnershipTransferJournal(value.journal)
  if (journal.side !== 'destination') {
    throw new Error('pty_ownership_transfer_destination_file_side_invalid')
  }
  if (
    value.version >= 2 !== (value.delegatedSource !== undefined) ||
    (value.version < 5 && value.version >= 3 !== (value.delegatedClaimIntent !== undefined)) ||
    (value.version < 5 && (value.version === 4) !== (value.delegatedInputs !== undefined)) ||
    (value.delegatedInputs !== undefined && value.delegatedClaimIntent === undefined) ||
    (value.version === 5) !== (value.catalogAdmission !== undefined)
  ) {
    throw new Error('pty_ownership_transfer_destination_file_delegation_invalid')
  }
  const delegatedSource =
    value.version >= 2
      ? parsePtyOwnershipTransferDelegatedSource(value.delegatedSource, journal)
      : undefined
  const delegatedClaimIntent =
    value.delegatedClaimIntent !== undefined
      ? parsePtyOwnershipTransferDelegatedClaimIntent(value.delegatedClaimIntent)
      : undefined
  const frames = parseFrames(value.frames, journal)
  const inputIds = parseInputIds(value.inputIds, maxInputIds)
  const surfaceBinding = parseOptionalSurfaceBinding(value.surfaceBinding)
  const catalogAdmission =
    value.version === 5 ? parseOrcadTerminalLayoutAdmission(value.catalogAdmission) : undefined
  if (catalogAdmission) {
    const admitted = catalogAdmission.bindings.find(({ identity }) =>
      samePtyOwnershipTransferIdentity(identity, journal)
    )
    if (
      !admitted ||
      (surfaceBinding &&
        !samePtyOwnershipTransferSurfaceBinding(admitted.surfaceBinding, surfaceBinding))
    ) {
      throw new Error('pty_ownership_transfer_destination_catalog_identity_invalid')
    }
  }
  const publicationIntent = parseOptionalPublicationIntent(value.publicationIntent, journal)
  if (journal.phase === 'prepared' && inputIds.length > 0) {
    throw new Error('pty_ownership_transfer_destination_file_input_phase_invalid')
  }
  if (
    journal.phase === 'aborted' &&
    (frames.length > 0 || inputIds.length > 0 || surfaceBinding || publicationIntent)
  ) {
    throw new Error('pty_ownership_transfer_destination_file_abort_payload_invalid')
  }
  if (publicationIntent) {
    if (
      !surfaceBinding ||
      !samePtyOwnershipTransferSurfaceBinding(publicationIntent.surfaceBinding, surfaceBinding)
    ) {
      throw new Error('pty_ownership_transfer_destination_publication_surface_mismatch')
    }
    if (journal.phase === 'prepared') {
      throw new Error('pty_ownership_transfer_destination_publication_phase_invalid')
    }
  }
  if (
    journal.phase === 'published' &&
    (!publicationIntent ||
      !journal.publicationReceipt ||
      !samePtyOwnershipTransferPublicationReceipt(publicationIntent, journal.publicationReceipt))
  ) {
    throw new Error('pty_ownership_transfer_destination_publication_intent_mismatch')
  }
  return {
    version: value.version,
    ...(catalogAdmission ? { catalogAdmission } : {}),
    ...(delegatedSource ? { delegatedSource } : {}),
    ...(delegatedClaimIntent ? { delegatedClaimIntent } : {}),
    ...(value.delegatedInputs !== undefined
      ? { delegatedInputs: parseDelegatedInputState(value.delegatedInputs, maxInputIds) }
      : {}),
    journal,
    frames,
    inputIds,
    ...(surfaceBinding ? { surfaceBinding } : {}),
    ...(publicationIntent ? { publicationIntent } : {})
  }
}

function parseOptionalSurfaceBinding(
  value: unknown
): PtyOwnershipTransferSurfaceBinding | undefined {
  return value === undefined ? undefined : parsePtyOwnershipTransferSurfaceBinding(value)
}

function parseOptionalPublicationIntent(
  value: unknown,
  journal: PtyOwnershipTransferDestinationJournal
): PtyOwnershipTransferPublicationReceipt | undefined {
  if (value === undefined) {
    return undefined
  }
  if (!journal.receipt) {
    throw new Error('pty_ownership_transfer_destination_publication_commit_missing')
  }
  return parsePtyOwnershipTransferPublicationReceipt(value, journal, journal.receipt)
}

function parseFrames(
  value: unknown,
  journal: PtyOwnershipTransferDestinationJournal
): PtyOwnershipTransferOutputFrame[] {
  if (
    !Array.isArray(value) ||
    value.length > PTY_OWNERSHIP_TRANSFER_DESTINATION_MAX_DURABLE_FRAMES
  ) {
    throw new Error('pty_ownership_transfer_destination_frames_invalid')
  }
  const frames: PtyOwnershipTransferOutputFrame[] = []
  let bytes = 0
  let expected = journal.acceptedSourceEndSeq - value.length + 1
  for (const candidate of value) {
    if (!isRecord(candidate)) {
      throw new Error('pty_ownership_transfer_destination_frame_invalid')
    }
    const data = candidate.data
    const seq = candidate.seq
    const truncated = candidate.truncated
    const frameBytes = typeof data === 'string' ? Buffer.byteLength(data, 'utf8') : 0
    if (
      !Number.isSafeInteger(seq) ||
      Number(seq) < 0 ||
      Number(seq) !== expected ||
      typeof data !== 'string' ||
      frameBytes <= 0 ||
      frameBytes > PTY_OWNERSHIP_TRANSFER_DESTINATION_MAX_FRAME_BYTES ||
      (truncated !== undefined && truncated !== true)
    ) {
      throw new Error('pty_ownership_transfer_destination_frame_invalid')
    }
    bytes += frameBytes
    if (bytes > PTY_OWNERSHIP_TRANSFER_DESTINATION_MAX_STAGED_BYTES) {
      throw new Error('pty_ownership_transfer_destination_frames_too_large')
    }
    frames.push({ seq: Number(seq), data, ...(truncated === true ? { truncated: true } : {}) })
    expected += 1
  }
  return frames
}

function parseInputIds(value: unknown, maxInputIds: number): { inputId: string; data: string }[] {
  if (!Array.isArray(value) || value.length > maxInputIds) {
    throw new Error('pty_ownership_transfer_destination_inputs_invalid')
  }
  const entries: { inputId: string; data: string }[] = []
  const seen = new Set<string>()
  let bytes = 0
  for (const candidate of value) {
    if (!isRecord(candidate) || typeof candidate.inputId !== 'string' || !candidate.inputId) {
      throw new Error('pty_ownership_transfer_destination_input_invalid')
    }
    if (candidate.inputId.length > 256 || typeof candidate.data !== 'string') {
      throw new Error('pty_ownership_transfer_destination_input_invalid')
    }
    if (seen.has(candidate.inputId)) {
      throw new Error('pty_ownership_transfer_destination_input_duplicate')
    }
    seen.add(candidate.inputId)
    bytes +=
      Buffer.byteLength(candidate.inputId, 'utf8') + Buffer.byteLength(candidate.data, 'utf8')
    if (bytes > PTY_OWNERSHIP_TRANSFER_DESTINATION_MAX_DURABLE_INPUT_BYTES) {
      throw new Error('pty_ownership_transfer_destination_inputs_too_large')
    }
    entries.push({ inputId: candidate.inputId, data: candidate.data })
  }
  return entries
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
