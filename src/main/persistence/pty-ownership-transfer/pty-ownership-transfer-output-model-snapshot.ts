import {
  validateOutputModelSnapshot,
  type PtyOwnershipTransferOutputOutboxRecord,
  type PtyOwnershipTransferOutputModelSnapshot
} from './pty-ownership-transfer-destination-output-outbox-record'

/** Snapshot bytes and their applied cursor share the outbox's single durable replacement. */
export function recordPtyOwnershipOutputModelSnapshot(
  record: PtyOwnershipTransferOutputOutboxRecord,
  value: PtyOwnershipTransferOutputModelSnapshot
): boolean {
  const snapshot = validateOutputModelSnapshot(value)
  const checkpoint = snapshot.checkpoint
  const previous = record.modelSnapshot?.checkpoint
  if (record.version >= 3 && !snapshot.restoreMetadata) {
    throw new Error('pty_ownership_transfer_model_restore_metadata_required')
  }
  if (
    record.initialModelSnapshot &&
    checkpoint.modelSequenceEnd <= record.initialModelSnapshot.modelSequenceEnd
  ) {
    throw new Error('pty_ownership_transfer_output_model_snapshot_conflict')
  }
  if (
    record.modelCheckpoints.some(
      (candidate) =>
        candidate.modelSequenceEnd > checkpoint.modelSequenceEnd ||
        candidate.frameSeq > checkpoint.frameSeq ||
        (candidate.frameSeq === checkpoint.frameSeq &&
          candidate.fragmentEndSu > checkpoint.fragmentEndSu)
    )
  ) {
    throw new Error('pty_ownership_transfer_output_model_snapshot_conflict')
  }
  if (record.modelSnapshot && JSON.stringify(record.modelSnapshot) === JSON.stringify(snapshot)) {
    return false
  }
  const frame = record.frames.find((candidate) => candidate.seq === checkpoint.frameSeq)
  if (
    !frame ||
    checkpoint.frameSeq <= record.acknowledgedEndSeq ||
    checkpoint.frameLengthSu !== frame.data.length ||
    frame.data.slice(checkpoint.fragmentStartSu, checkpoint.fragmentEndSu) !== checkpoint.data ||
    (previous &&
      (checkpoint.ptyId !== previous.ptyId ||
        checkpoint.modelSequenceEnd <= previous.modelSequenceEnd))
  ) {
    throw new Error('pty_ownership_transfer_output_model_snapshot_conflict')
  }
  const followsPrevious = previous
    ? (checkpoint.frameSeq === previous.frameSeq &&
        checkpoint.fragmentStartSu === previous.fragmentEndSu) ||
      (checkpoint.frameSeq === previous.frameSeq + 1 &&
        checkpoint.fragmentStartSu === 0 &&
        previous.fragmentEndSu === previous.frameLengthSu)
    : checkpoint.frameSeq === record.acknowledgedEndSeq + 1 && checkpoint.fragmentStartSu === 0
  if (!followsPrevious) {
    throw new Error('pty_ownership_transfer_output_model_snapshot_gap')
  }
  const existing = record.modelCheckpoints.find(
    (candidate) =>
      candidate.frameSeq === checkpoint.frameSeq &&
      candidate.fragmentStartSu === checkpoint.fragmentStartSu
  )
  if (existing && JSON.stringify(existing) !== JSON.stringify(checkpoint)) {
    throw new Error('pty_ownership_transfer_output_model_snapshot_conflict')
  }
  if (!existing) {
    if (record.modelCheckpoints.length >= 4096) {
      throw new Error('pty_ownership_transfer_output_model_checkpoint_capacity')
    }
    record.modelCheckpoints.push(checkpoint)
  }
  record.version = record.modelClear
    ? 5
    : record.initialModelSnapshot
      ? 4
      : snapshot.restoreMetadata
        ? 3
        : 2
  record.modelSnapshot = snapshot
  return true
}
