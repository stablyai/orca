import type {
  PtyOwnershipTransferCommitReceipt,
  PtyOwnershipTransferPublicationReceipt
} from '../shared/pty-ownership-transfer-journal-contract'
import type { PtyOwnershipTransferOutputFrame } from '../shared/pty-ownership-transfer-wire'
import { samePtyOwnershipTransferSurfaceBinding } from '../shared/pty-ownership-transfer-surface-binding'

export const MAX_OUTPUT_FRAME_BYTES = 16 * 1024

export function boundedTransferPositive(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('PTY ownership transfer bound must be a positive safe integer')
  }
  return Math.min(value, maximum)
}

export function splitTransferOutputFrames(
  data: string,
  nextSeq: () => number
): PtyOwnershipTransferOutputFrame[] {
  const frames: PtyOwnershipTransferOutputFrame[] = []
  let offset = 0
  while (offset < data.length) {
    let end = offset
    let bytes = 0
    while (end < data.length) {
      const codePoint = String.fromCodePoint(data.codePointAt(end)!)
      const codePointBytes = Buffer.byteLength(codePoint, 'utf8')
      if (end > offset && bytes + codePointBytes > MAX_OUTPUT_FRAME_BYTES) {
        break
      }
      bytes += codePointBytes
      end += codePoint.length
      if (bytes >= MAX_OUTPUT_FRAME_BYTES) {
        break
      }
    }
    if (end === offset) {
      end++
    }
    frames.push(Object.freeze({ seq: nextSeq(), data: data.slice(offset, end) }))
    offset = end
  }
  return frames
}

export function sameTransferCommitReceipt(
  left: PtyOwnershipTransferCommitReceipt,
  right: PtyOwnershipTransferCommitReceipt
): boolean {
  return (
    left.receiptId === right.receiptId &&
    left.bridgeId === right.bridgeId &&
    left.acceptedSourceEndSeq === right.acceptedSourceEndSeq &&
    left.committedAt === right.committedAt
  )
}

export function sameTransferPublicationReceipt(
  left: PtyOwnershipTransferPublicationReceipt,
  right: PtyOwnershipTransferPublicationReceipt
): boolean {
  return (
    left.version === right.version &&
    left.publicationReceiptId === right.publicationReceiptId &&
    left.bridgeId === right.bridgeId &&
    left.destinationRuntimeId === right.destinationRuntimeId &&
    left.publishedAt === right.publishedAt &&
    sameTransferCommitReceipt(left.commitReceipt, right.commitReceipt) &&
    samePtyOwnershipTransferSurfaceBinding(left.surfaceBinding, right.surfaceBinding)
  )
}
