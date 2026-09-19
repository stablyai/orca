import type { PtyOwnershipTransferIdentity } from '../../../shared/pty-ownership-transfer-journal'
import {
  parsePtyOwnershipTransferWireIdentity,
  type PtyOwnershipTransferOutputFrame
} from '../../../shared/pty-ownership-transfer-wire'
import { recordPtyOwnershipOutputModelSnapshot } from './pty-ownership-transfer-output-model-snapshot'
import {
  recordPtyOwnershipModelRetirement,
  assertPtyOwnershipModelNotRetired
} from './pty-ownership-transfer-model-retirement'
import {
  recordPtyOwnershipModelClear,
  restorablePtyOwnershipModel,
  type PtyOwnershipModelClearRequest
} from './pty-ownership-transfer-model-clear'
import {
  recordPtyOwnershipInitialModelSnapshot,
  type PtyOwnershipInitialModelSnapshot
} from './pty-ownership-transfer-initial-model-snapshot'
import { requireOutputOutboxCapacity } from './pty-ownership-transfer-output-outbox-capacity'
import {
  frameBytes,
  contiguousEndSeq,
  sameModelCheckpoint,
  sameFrame,
  requireSequence,
  snapshotOutputOutboxRecord,
  validateOutputModelCheckpoint,
  validateOutputOutboxFrame,
  type PtyOwnershipTransferOutputModelCheckpoint,
  type PtyOwnershipTransferOutputModelSnapshot,
  type PtyOwnershipTransferDestinationOutputSnapshot,
  type PtyOwnershipTransferOutputOutboxRecord
} from './pty-ownership-transfer-destination-output-outbox-record'

export type { PtyOwnershipTransferDestinationOutputSnapshot } from './pty-ownership-transfer-destination-output-outbox-record'

export {
  PTY_OWNERSHIP_TRANSFER_OUTPUT_OUTBOX_MAX_BYTES,
  PTY_OWNERSHIP_TRANSFER_OUTPUT_OUTBOX_MAX_FRAMES
} from './pty-ownership-transfer-output-outbox-storage'
import { PtyOwnershipTransferOutputOutboxStorage } from './pty-ownership-transfer-output-outbox-storage'

/** Crash-safe queue between credited SSH output and the durable destination terminal surface. */
export class PtyOwnershipTransferDestinationOutputOutbox extends PtyOwnershipTransferOutputOutboxStorage {
  open(
    identity: PtyOwnershipTransferIdentity,
    baseEndSeq: number
  ): PtyOwnershipTransferDestinationOutputSnapshot {
    const validatedIdentity = parsePtyOwnershipTransferWireIdentity(identity)
    requireSequence(baseEndSeq)
    const existing = this.loadRecord(validatedIdentity)
    if (existing) {
      if (existing.baseEndSeq !== baseEndSeq) {
        throw new Error('pty_ownership_transfer_output_outbox_base_conflict')
      }
      return snapshotOutputOutboxRecord(existing)
    }
    requireOutputOutboxCapacity(this.options.directory, this.maxRecords)
    const record: PtyOwnershipTransferOutputOutboxRecord = {
      version: 1,
      identity: validatedIdentity,
      baseEndSeq,
      acknowledgedEndSeq: baseEndSeq,
      frames: [],
      modelCheckpoints: []
    }
    this.persist(record)
    return snapshotOutputOutboxRecord(record)
  }

  enqueue(
    identity: PtyOwnershipTransferIdentity,
    frame: PtyOwnershipTransferOutputFrame
  ): 'accepted' | 'duplicate' | 'acknowledged' {
    return this.insert(identity, frame, false)
  }

  /** Durably retain a future live frame while attachment recovery fills an earlier gap. */
  stage(
    identity: PtyOwnershipTransferIdentity,
    frame: PtyOwnershipTransferOutputFrame
  ): 'accepted' | 'duplicate' | 'acknowledged' {
    return this.insert(identity, frame, true)
  }

  private insert(
    identity: PtyOwnershipTransferIdentity,
    frame: PtyOwnershipTransferOutputFrame,
    allowGap: boolean
  ): 'accepted' | 'duplicate' | 'acknowledged' {
    const record = this.requireRecord(identity)
    const validated = validateOutputOutboxFrame(frame)
    if (validated.seq <= record.acknowledgedEndSeq) {
      return 'acknowledged'
    }
    assertPtyOwnershipModelNotRetired(record)
    const existingIndex = record.frames.findIndex((candidate) => candidate.seq >= validated.seq)
    const existing = existingIndex === -1 ? undefined : record.frames[existingIndex]
    if (existing?.seq === validated.seq) {
      if (!sameFrame(existing, validated)) {
        throw new Error('pty_ownership_transfer_output_outbox_frame_conflict')
      }
      return 'duplicate'
    }
    if (!allowGap && validated.seq !== contiguousEndSeq(record) + 1) {
      throw new Error('pty_ownership_transfer_output_outbox_gap')
    }
    const nextBytes = frameBytes(record.frames) + Buffer.byteLength(validated.data, 'utf8')
    if (record.frames.length >= this.maxFrames || nextBytes > this.maxBytes) {
      throw new Error('pty_ownership_transfer_output_outbox_backpressure')
    }
    if (existingIndex === -1) {
      record.frames.push(validated)
    } else {
      record.frames.splice(existingIndex, 0, validated)
    }
    this.persist(record)
    return 'accepted'
  }

  acknowledge(
    identity: PtyOwnershipTransferIdentity,
    throughSeq: number
  ): PtyOwnershipTransferDestinationOutputSnapshot {
    const record = this.requireRecord(identity)
    requireSequence(throughSeq)
    if (throughSeq <= record.acknowledgedEndSeq) {
      return snapshotOutputOutboxRecord(record)
    }
    if (throughSeq > contiguousEndSeq(record)) {
      throw new Error('pty_ownership_transfer_output_outbox_ack_ahead')
    }
    if (record.initialModelSnapshot && !record.modelSnapshot) {
      throw new Error('pty_ownership_transfer_output_model_snapshot_ack_ahead')
    }
    if (
      record.modelSnapshot &&
      (throughSeq > record.modelSnapshot.checkpoint.frameSeq ||
        (throughSeq === record.modelSnapshot.checkpoint.frameSeq &&
          record.modelSnapshot.checkpoint.fragmentEndSu !==
            record.modelSnapshot.checkpoint.frameLengthSu))
    ) {
      throw new Error('pty_ownership_transfer_output_model_snapshot_ack_ahead')
    }
    record.frames = record.frames.filter((frame) => frame.seq > throughSeq)
    record.modelCheckpoints = record.modelCheckpoints.filter(
      (checkpoint) => checkpoint.frameSeq > throughSeq
    )
    record.acknowledgedEndSeq = throughSeq
    this.persist(record)
    return snapshotOutputOutboxRecord(record)
  }

  /** Advance the durable baseline after replayed frames are committed at the destination. */
  markCommittedThrough(
    identity: PtyOwnershipTransferIdentity,
    throughSeq: number
  ): PtyOwnershipTransferDestinationOutputSnapshot {
    const record = this.requireRecord(identity)
    requireSequence(throughSeq)
    if (throughSeq < record.acknowledgedEndSeq) {
      throw new Error('pty_ownership_transfer_output_outbox_ack_regressed')
    }
    if (record.frames.length > 0 && throughSeq > record.acknowledgedEndSeq) {
      throw new Error('pty_ownership_transfer_output_outbox_pending_baseline')
    }
    if (throughSeq === record.acknowledgedEndSeq) {
      return snapshotOutputOutboxRecord(record)
    }
    assertPtyOwnershipModelNotRetired(record)
    if (record.modelSnapshot || record.initialModelSnapshot) {
      throw new Error('pty_ownership_transfer_output_model_snapshot_baseline_conflict')
    }
    record.acknowledgedEndSeq = throughSeq
    record.modelCheckpoints = record.modelCheckpoints.filter(
      (checkpoint) => checkpoint.frameSeq > throughSeq
    )
    this.persist(record)
    return snapshotOutputOutboxRecord(record)
  }

  load(
    identity: PtyOwnershipTransferIdentity
  ): PtyOwnershipTransferDestinationOutputSnapshot | null {
    const validated = parsePtyOwnershipTransferWireIdentity(identity)
    const record = this.loadRecord(validated)
    return record ? snapshotOutputOutboxRecord(record) : null
  }

  recordModelCheckpoint(
    identity: PtyOwnershipTransferIdentity,
    checkpoint: PtyOwnershipTransferOutputModelCheckpoint
  ): void {
    const record = this.requireRecord(identity)
    assertPtyOwnershipModelNotRetired(record)
    const validated = validateOutputModelCheckpoint(checkpoint)
    const existing = record.modelCheckpoints.find(
      (candidate) =>
        candidate.frameSeq === validated.frameSeq &&
        candidate.fragmentStartSu === validated.fragmentStartSu
    )
    if (existing) {
      if (!sameModelCheckpoint(existing, validated)) {
        throw new Error('pty_ownership_transfer_output_model_checkpoint_conflict')
      }
      return
    }
    if (record.modelSnapshot || record.initialModelSnapshot) {
      throw new Error('pty_ownership_transfer_output_model_snapshot_required')
    }
    if (record.modelCheckpoints.length >= 4_096) {
      throw new Error('pty_ownership_transfer_output_model_checkpoint_capacity')
    }
    record.modelCheckpoints.push({ ...validated })
    this.persist(record)
  }

  loadModelCheckpoints(
    identity: PtyOwnershipTransferIdentity
  ): readonly PtyOwnershipTransferOutputModelCheckpoint[] {
    return this.requireRecord(identity).modelCheckpoints.map((checkpoint) => ({ ...checkpoint }))
  }

  recordModelSnapshot(
    identity: PtyOwnershipTransferIdentity,
    snapshot: PtyOwnershipTransferOutputModelSnapshot
  ): void {
    const record = this.requireRecord(identity)
    assertPtyOwnershipModelNotRetired(record)
    if (recordPtyOwnershipOutputModelSnapshot(record, snapshot)) {
      this.persist(record)
    }
  }

  loadModelSnapshot(
    identity: PtyOwnershipTransferIdentity
  ): PtyOwnershipTransferOutputModelSnapshot | null {
    return structuredClone(this.requireRecord(identity).modelSnapshot ?? null)
  }

  recordModelClear(
    identity: PtyOwnershipTransferIdentity,
    request: PtyOwnershipModelClearRequest
  ): void {
    const record = this.requireRecord(identity)
    assertPtyOwnershipModelNotRetired(record)
    if (recordPtyOwnershipModelClear(record, request)) {
      this.persist(record)
    }
  }

  loadModelClear(identity: PtyOwnershipTransferIdentity) {
    return structuredClone(this.requireRecord(identity).modelClear ?? null)
  }

  loadRestorableModel(identity: PtyOwnershipTransferIdentity) {
    return structuredClone(restorablePtyOwnershipModel(this.requireRecord(identity)))
  }

  /** One durable record binds sink acknowledgment to a complete restorable model boundary. */
  inspectAppliedCoverage(identity: PtyOwnershipTransferIdentity, throughSeq: number) {
    requireSequence(throughSeq)
    const record = this.requireRecord(identity)
    assertPtyOwnershipModelNotRetired(record)
    const model = restorablePtyOwnershipModel(record)
    if (!model?.restoreMetadata) {
      throw new Error('pty_ownership_transfer_applied_coverage_model_required')
    }
    const modelThroughSeq =
      'checkpoint' in model
        ? model.checkpoint.frameSeq -
          (model.checkpoint.fragmentEndSu < model.checkpoint.frameLengthSu ? 1 : 0)
        : model.throughSeq
    const modelSequenceEnd =
      'checkpoint' in model ? model.checkpoint.modelSequenceEnd : model.modelSequenceEnd
    if (throughSeq > record.acknowledgedEndSeq || throughSeq > modelThroughSeq) {
      throw new Error('pty_ownership_transfer_applied_coverage_unconfirmed')
    }
    return Object.freeze({
      throughSeq,
      acknowledgedEndSeq: record.acknowledgedEndSeq,
      modelThroughSeq,
      modelSequenceEnd
    })
  }

  recordInitialModelSnapshot(identity: PtyOwnershipTransferIdentity, snapshot: unknown): void {
    const record = this.requireRecord(identity)
    assertPtyOwnershipModelNotRetired(record)
    if (recordPtyOwnershipInitialModelSnapshot(record, snapshot)) {
      this.persist(record)
    }
  }

  loadInitialModelSnapshot(
    identity: PtyOwnershipTransferIdentity
  ): PtyOwnershipInitialModelSnapshot | null {
    return structuredClone(this.requireRecord(identity).initialModelSnapshot ?? null)
  }

  recordRetirement(identity: PtyOwnershipTransferIdentity, value: unknown): void {
    const record = this.requireRecord(identity)
    if (recordPtyOwnershipModelRetirement(record, value)) {
      this.persist(record)
    }
  }

  loadRetirement(identity: PtyOwnershipTransferIdentity) {
    return structuredClone(this.requireRecord(identity).retirement ?? null)
  }
}
