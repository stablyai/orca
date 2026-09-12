import type { PtyOwnershipTransferOutputFrame } from '../../../shared/pty-ownership-transfer-wire'
import type {
  PtyOwnershipTransferOutputOutboxRecord,
  PtyOwnershipTransferDestinationOutputSnapshot
} from './pty-ownership-transfer-destination-output-outbox-record'

export function snapshotOutputOutboxRecord(
  record: PtyOwnershipTransferOutputOutboxRecord
): PtyOwnershipTransferDestinationOutputSnapshot {
  const pendingFrames = Object.freeze(record.frames.map((frame) => Object.freeze({ ...frame })))
  return Object.freeze({
    identity: Object.freeze({ ...record.identity }),
    baseEndSeq: record.baseEndSeq,
    acknowledgedEndSeq: record.acknowledgedEndSeq,
    acceptedEndSeq: pendingFrames.at(-1)?.seq ?? record.acknowledgedEndSeq,
    pendingBytes: frameBytes(pendingFrames),
    pendingFrames
  })
}

export function frameBytes(frames: readonly PtyOwnershipTransferOutputFrame[]): number {
  return frames.reduce((total, frame) => total + Buffer.byteLength(frame.data, 'utf8'), 0)
}

export function contiguousEndSeq(
  record: Pick<PtyOwnershipTransferOutputOutboxRecord, 'acknowledgedEndSeq' | 'frames'>
): number {
  let throughSeq = record.acknowledgedEndSeq
  for (const frame of record.frames) {
    if (frame.seq !== throughSeq + 1) {
      break
    }
    throughSeq = frame.seq
  }
  return throughSeq
}
