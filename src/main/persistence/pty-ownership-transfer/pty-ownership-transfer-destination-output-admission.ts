import type {
  PtyOwnershipTransferOutputFrame,
  PtyOwnershipTransferWireIdentity
} from '../../../shared/pty-ownership-transfer-wire'
import { samePtyOwnershipTransferIdentity } from '../../../shared/pty-ownership-transfer-identity'
import {
  PTY_OWNERSHIP_TRANSFER_OUTPUT_OUTBOX_MAX_BYTES,
  PTY_OWNERSHIP_TRANSFER_OUTPUT_OUTBOX_MAX_FRAMES
} from './pty-ownership-transfer-destination-output-outbox'

type PendingOutput = Readonly<{
  frame: PtyOwnershipTransferOutputFrame
  promise: Promise<void>
  resolve: () => void
  reject: (error: Error) => void
}>

type PendingOutputQueue = {
  identity: PtyOwnershipTransferWireIdentity
  entries: PendingOutput[]
  bytes: number
}

type OutputAdmissionOptions = Readonly<{
  maxBytes?: number
  maxFrames?: number
}>

/** Bounded ordered queue while recovery owns the destination attachment barrier. */
export class PtyOwnershipTransferDestinationOutputAdmission {
  private readonly pending = new Map<string, PendingOutputQueue>()
  private readonly maxBytes: number
  private readonly maxFrames: number

  constructor(options: OutputAdmissionOptions = {}) {
    this.maxBytes = boundedLimit(
      options.maxBytes ?? PTY_OWNERSHIP_TRANSFER_OUTPUT_OUTBOX_MAX_BYTES,
      PTY_OWNERSHIP_TRANSFER_OUTPUT_OUTBOX_MAX_BYTES
    )
    this.maxFrames = boundedLimit(
      options.maxFrames ?? PTY_OWNERSHIP_TRANSFER_OUTPUT_OUTBOX_MAX_FRAMES,
      PTY_OWNERSHIP_TRANSFER_OUTPUT_OUTBOX_MAX_FRAMES
    )
  }

  defer(
    identity: PtyOwnershipTransferWireIdentity,
    frame: PtyOwnershipTransferOutputFrame
  ): Promise<void> {
    let queue = this.pending.get(identity.bridgeId)
    let created = false
    if (queue) {
      if (!samePtyOwnershipTransferIdentity(queue.identity, identity)) {
        throw new Error('pty_ownership_transfer_output_admission_identity_conflict')
      }
    } else {
      queue = {
        identity: Object.freeze({ ...identity }),
        entries: [],
        bytes: 0
      }
      this.pending.set(identity.bridgeId, queue)
      created = true
    }

    const existingIndex = queue.entries.findIndex((entry) => entry.frame.seq >= frame.seq)
    const existing = existingIndex === -1 ? undefined : queue.entries[existingIndex]
    if (existing?.frame.seq === frame.seq) {
      if (!sameFrame(existing.frame, frame)) {
        throw new Error('pty_ownership_transfer_output_admission_conflict')
      }
      return existing.promise
    }
    const frameBytes = Buffer.byteLength(frame.data, 'utf8')
    if (queue.entries.length >= this.maxFrames || queue.bytes + frameBytes > this.maxBytes) {
      if (created) {
        this.pending.delete(identity.bridgeId)
      }
      throw new Error('pty_ownership_transfer_output_admission_backpressure')
    }
    let resolve!: () => void
    let reject!: (error: Error) => void
    const promise = new Promise<void>((onResolve, onReject) => {
      resolve = onResolve
      reject = onReject
    })
    const entry: PendingOutput = {
      frame: Object.freeze({ ...frame }),
      promise,
      resolve,
      reject
    }
    if (existingIndex === -1) {
      queue.entries.push(entry)
    } else {
      queue.entries.splice(existingIndex, 0, entry)
    }
    queue.bytes += frameBytes
    return promise
  }

  settle(
    identity: PtyOwnershipTransferWireIdentity,
    accept: (frame: PtyOwnershipTransferOutputFrame) => void
  ): void {
    const queue = this.pending.get(identity.bridgeId)
    if (!queue) {
      return
    }
    if (!samePtyOwnershipTransferIdentity(queue.identity, identity)) {
      throw new Error('pty_ownership_transfer_output_admission_identity_conflict')
    }
    this.pending.delete(identity.bridgeId)
    let failed: Error | undefined
    for (const entry of queue.entries) {
      if (failed) {
        entry.reject(failed)
        continue
      }
      try {
        accept(entry.frame)
        entry.resolve()
      } catch (error) {
        failed = asError(error)
        entry.reject(failed)
      }
    }
  }

  reject(identity: PtyOwnershipTransferWireIdentity, error: unknown): void {
    const queue = this.pending.get(identity.bridgeId)
    if (!queue) {
      return
    }
    if (!samePtyOwnershipTransferIdentity(queue.identity, identity)) {
      throw new Error('pty_ownership_transfer_output_admission_identity_conflict')
    }
    this.pending.delete(identity.bridgeId)
    const failure = asError(error)
    for (const entry of queue.entries) {
      entry.reject(failure)
    }
  }
}

function sameFrame(
  left: PtyOwnershipTransferOutputFrame,
  right: PtyOwnershipTransferOutputFrame
): boolean {
  return left.seq === right.seq && left.data === right.data && left.truncated === right.truncated
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function boundedLimit(value: number, max: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) {
    throw new Error('pty_ownership_transfer_output_admission_limit_invalid')
  }
  return value
}
