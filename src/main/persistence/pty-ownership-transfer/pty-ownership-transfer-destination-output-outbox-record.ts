import { contiguousEndSeq } from './pty-ownership-transfer-output-cursors'
import {
  parsePtyOwnershipModelRetirement,
  type PtyOwnershipModelRetirement
} from './pty-ownership-transfer-model-retirement'
import {
  parsePtyOwnershipModelClear,
  type PtyOwnershipModelClear
} from './pty-ownership-transfer-model-clear'
export {
  frameBytes,
  contiguousEndSeq,
  snapshotOutputOutboxRecord
} from './pty-ownership-transfer-output-cursors'
import { PTY_OWNERSHIP_TRANSFER_DESTINATION_MAX_FRAME_BYTES } from '../../../shared/pty-ownership-transfer-destination-adapter'
import type { PtyOwnershipTransferIdentity } from '../../../shared/pty-ownership-transfer-journal'
import { samePtyOwnershipTransferIdentity } from '../../../shared/pty-ownership-transfer-identity'
import type { PtyOwnershipModelRestoreMetadata } from './pty-ownership-transfer-model-restore-metadata'
import { parsePtyOwnershipModelPayload } from './pty-ownership-transfer-model-payload'
import {
  parsePtyOwnershipInitialModelSnapshot,
  type PtyOwnershipInitialModelSnapshot
} from './pty-ownership-transfer-initial-model-snapshot'
import {
  parsePtyOwnershipTransferWireIdentity,
  type PtyOwnershipTransferOutputFrame
} from '../../../shared/pty-ownership-transfer-wire'

export type PtyOwnershipTransferOutputOutboxRecord = {
  version: 1 | 2 | 3 | 4 | 5 | 6
  identity: PtyOwnershipTransferIdentity
  baseEndSeq: number
  acknowledgedEndSeq: number
  frames: PtyOwnershipTransferOutputFrame[]
  modelCheckpoints: PtyOwnershipTransferOutputModelCheckpoint[]
  modelSnapshot?: PtyOwnershipTransferOutputModelSnapshot
  initialModelSnapshot?: PtyOwnershipInitialModelSnapshot
  modelClear?: PtyOwnershipModelClear
  retirement?: PtyOwnershipModelRetirement
}

export type PtyOwnershipTransferOutputModelSnapshot = {
  checkpoint: PtyOwnershipTransferOutputModelCheckpoint
  modelData: string
  cols: number
  rows: number
  restoreMetadata?: PtyOwnershipModelRestoreMetadata
}

import {
  parseModelCheckpoints,
  validateOutputModelCheckpoint,
  sameModelCheckpoint,
  MAX_PTY_OWNERSHIP_TRANSFER_OUTPUT_MODEL_CHECKPOINTS,
  type PtyOwnershipTransferOutputModelCheckpoint
} from './pty-ownership-transfer-output-model-checkpoint'
export {
  validateOutputModelCheckpoint,
  sameModelCheckpoint,
  MAX_PTY_OWNERSHIP_TRANSFER_OUTPUT_MODEL_CHECKPOINTS,
  type PtyOwnershipTransferOutputModelCheckpoint
} from './pty-ownership-transfer-output-model-checkpoint'

export type PtyOwnershipTransferDestinationOutputSnapshot = Readonly<{
  identity: PtyOwnershipTransferIdentity
  baseEndSeq: number
  acknowledgedEndSeq: number
  acceptedEndSeq: number
  pendingBytes: number
  pendingFrames: readonly PtyOwnershipTransferOutputFrame[]
}>

export function parseOutputOutboxRecord(
  value: unknown,
  expectedIdentity: PtyOwnershipTransferIdentity,
  limits: Readonly<{ maxBytes: number; maxFrames: number }>
): PtyOwnershipTransferOutputOutboxRecord {
  if (isRecord(value) && value.version === 6) {
    const record = parseOutputOutboxRecord(
      {
        ...value,
        retirement: undefined,
        version: value.modelClear
          ? 5
          : value.initialModelSnapshot
            ? 4
            : value.modelSnapshot
              ? (value.modelSnapshot as Record<string, unknown>).restoreMetadata
                ? 3
                : 2
              : 1
      },
      expectedIdentity,
      limits
    )
    return {
      ...record,
      version: 6,
      retirement: parsePtyOwnershipModelRetirement(value.retirement, record)
    }
  }
  if (isRecord(value) && value.retirement !== undefined) {
    throw new Error('pty_ownership_transfer_output_outbox_version_invalid')
  }
  if (isRecord(value) && value.version === 5) {
    const record = parseOutputOutboxRecord(
      {
        ...value,
        version: value.initialModelSnapshot ? 4 : 3,
        modelClear: undefined
      },
      expectedIdentity,
      limits
    )
    return {
      ...record,
      version: 5,
      modelClear: parsePtyOwnershipModelClear(value.modelClear, record)
    }
  }
  if (
    !isRecord(value) ||
    ![1, 2, 3, 4].includes(Number(value.version)) ||
    typeof value.version !== 'number' ||
    value.modelClear !== undefined
  ) {
    throw new Error('pty_ownership_transfer_output_outbox_version_invalid')
  }
  const identity = parsePtyOwnershipTransferWireIdentity(value.identity)
  if (!samePtyOwnershipTransferIdentity(identity, expectedIdentity)) {
    throw new Error('pty_ownership_transfer_output_outbox_identity_conflict')
  }
  const baseEndSeq = requireSequence(value.baseEndSeq)
  const acknowledgedEndSeq = requireSequence(value.acknowledgedEndSeq)
  if (
    acknowledgedEndSeq < baseEndSeq ||
    !Array.isArray(value.frames) ||
    value.frames.length > limits.maxFrames ||
    (value.modelCheckpoints !== undefined &&
      (!Array.isArray(value.modelCheckpoints) ||
        value.modelCheckpoints.length > MAX_PTY_OWNERSHIP_TRANSFER_OUTPUT_MODEL_CHECKPOINTS))
  ) {
    throw new Error('pty_ownership_transfer_output_outbox_cursor_invalid')
  }
  const frames: PtyOwnershipTransferOutputFrame[] = []
  let previousSeq = acknowledgedEndSeq
  let bytes = 0
  for (const candidate of value.frames) {
    const frame = validateOutputOutboxFrame(candidate)
    bytes += Buffer.byteLength(frame.data, 'utf8')
    if (frame.seq <= previousSeq || bytes > limits.maxBytes) {
      throw new Error('pty_ownership_transfer_output_outbox_frames_invalid')
    }
    previousSeq = frame.seq
    frames.push(frame)
  }
  const modelCheckpoints = parseModelCheckpoints(value.modelCheckpoints)
  if (value.version !== 4 && value.initialModelSnapshot !== undefined) {
    throw new Error('pty_ownership_transfer_output_outbox_version_invalid')
  }
  const initialModelSnapshot =
    value.version === 4
      ? parsePtyOwnershipInitialModelSnapshot(value.initialModelSnapshot, identity, baseEndSeq)
      : undefined
  if (value.version === 1 && value.modelSnapshot !== undefined) {
    throw new Error('pty_ownership_transfer_output_outbox_version_invalid')
  }
  const modelSnapshot =
    value.version !== 1 && !(value.version === 4 && value.modelSnapshot === undefined)
      ? validateOutputModelSnapshot(value.modelSnapshot)
      : undefined
  if (
    value.version !== 4 &&
    (value.version === 3) !== (modelSnapshot?.restoreMetadata !== undefined)
  ) {
    throw new Error('pty_ownership_transfer_output_outbox_version_invalid')
  }
  if (
    initialModelSnapshot &&
    (((acknowledgedEndSeq > baseEndSeq || modelCheckpoints.length > 0) && !modelSnapshot) ||
      (modelSnapshot &&
        (!modelSnapshot.restoreMetadata ||
          modelSnapshot.checkpoint.modelSequenceEnd <= initialModelSnapshot.modelSequenceEnd)))
  ) {
    throw new Error('pty_ownership_transfer_initial_model_snapshot_conflict')
  }
  if (
    modelSnapshot &&
    (modelSnapshot.checkpoint.frameSeq <= baseEndSeq ||
      modelSnapshot.checkpoint.frameSeq < acknowledgedEndSeq ||
      modelSnapshot.checkpoint.frameSeq > contiguousEndSeq({ acknowledgedEndSeq, frames }) ||
      (modelSnapshot.checkpoint.frameSeq <= acknowledgedEndSeq &&
        modelSnapshot.checkpoint.fragmentEndSu !== modelSnapshot.checkpoint.frameLengthSu))
  ) {
    throw new Error('pty_ownership_transfer_output_model_snapshot_cursor_invalid')
  }
  if (
    modelSnapshot &&
    modelCheckpoints.some(
      (checkpoint) =>
        checkpoint.modelSequenceEnd > modelSnapshot.checkpoint.modelSequenceEnd ||
        checkpoint.frameSeq > modelSnapshot.checkpoint.frameSeq ||
        (checkpoint.frameSeq === modelSnapshot.checkpoint.frameSeq &&
          checkpoint.fragmentEndSu > modelSnapshot.checkpoint.fragmentEndSu)
    )
  ) {
    throw new Error('pty_ownership_transfer_output_model_snapshot_cursor_invalid')
  }
  if (modelSnapshot && modelSnapshot.checkpoint.frameSeq > acknowledgedEndSeq) {
    const checkpoint = modelSnapshot.checkpoint
    const frame = frames.find((frame) => frame.seq === checkpoint.frameSeq)!
    if (
      checkpoint.frameLengthSu !== frame.data.length ||
      frame.data.slice(checkpoint.fragmentStartSu, checkpoint.fragmentEndSu) !== checkpoint.data ||
      !modelCheckpoints.some((candidate) => sameModelCheckpoint(candidate, checkpoint))
    ) {
      throw new Error('pty_ownership_transfer_output_model_snapshot_conflict')
    }
  }
  return {
    version: value.version as 1 | 2 | 3 | 4,
    identity,
    baseEndSeq,
    acknowledgedEndSeq,
    frames,
    modelCheckpoints,
    ...(modelSnapshot ? { modelSnapshot } : {}),
    ...(initialModelSnapshot ? { initialModelSnapshot } : {})
  }
}

export function validateOutputModelSnapshot(
  value: unknown
): PtyOwnershipTransferOutputModelSnapshot {
  const payload = parsePtyOwnershipModelPayload(value)
  return {
    checkpoint: validateOutputModelCheckpoint((value as Record<string, unknown>).checkpoint),
    ...payload
  }
}

export function validateOutputOutboxFrame(value: unknown): PtyOwnershipTransferOutputFrame {
  if (!isRecord(value) || !Number.isSafeInteger(value.seq) || Number(value.seq) <= 0) {
    throw new Error('pty_ownership_transfer_output_outbox_frame_invalid')
  }
  const data = value.data
  const bytes = typeof data === 'string' ? Buffer.byteLength(data, 'utf8') : 0
  if (
    typeof data !== 'string' ||
    data.length === 0 ||
    bytes > PTY_OWNERSHIP_TRANSFER_DESTINATION_MAX_FRAME_BYTES ||
    value.truncated !== undefined
  ) {
    throw new Error('pty_ownership_transfer_output_outbox_frame_invalid')
  }
  return { seq: Number(value.seq), data }
}

export function sameFrame(
  left: PtyOwnershipTransferOutputFrame,
  right: PtyOwnershipTransferOutputFrame
): boolean {
  return left.seq === right.seq && left.data === right.data && left.truncated === right.truncated
}

export function requireSequence(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error('pty_ownership_transfer_output_outbox_sequence_invalid')
  }
  return Number(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
