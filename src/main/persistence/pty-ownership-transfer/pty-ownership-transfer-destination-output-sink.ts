import type { PtyOwnershipTransferOutputFrame } from '../../../shared/pty-ownership-transfer-wire'
import type { PtyOwnershipTransferWireIdentity } from '../../../shared/pty-ownership-transfer-wire'
import type { PtyOwnershipTransferSurfaceBinding } from '../../../shared/pty-ownership-transfer-surface-binding'
import { samePtyOwnershipTransferIdentity } from '../../../shared/pty-ownership-transfer-identity'
import type {
  PtyOwnershipTransferDestinationOutputOutbox,
  PtyOwnershipTransferDestinationOutputSnapshot
} from './pty-ownership-transfer-destination-output-outbox'

export type PtyOwnershipTransferOutputAcknowledgement = Readonly<{
  identity: PtyOwnershipTransferWireIdentity
  throughSeq: number
}>

export type PtyOwnershipTransferDestinationOutputDelivery = (
  identity: PtyOwnershipTransferWireIdentity,
  surfaceBinding: PtyOwnershipTransferSurfaceBinding,
  frame: PtyOwnershipTransferOutputFrame
) => PtyOwnershipTransferOutputAcknowledgement

export type PtyOwnershipTransferDestinationOutputSinkOptions = Readonly<{
  outbox: PtyOwnershipTransferDestinationOutputOutbox
  deliver: PtyOwnershipTransferDestinationOutputDelivery
}>

/** Durable destination output boundary: enqueue first, then advance only on exact host ack. */
export class PtyOwnershipTransferDestinationOutputSink {
  constructor(private readonly options: PtyOwnershipTransferDestinationOutputSinkOptions) {}

  open(
    identity: PtyOwnershipTransferWireIdentity,
    baseEndSeq: number
  ): PtyOwnershipTransferDestinationOutputSnapshot {
    return this.options.outbox.open(identity, baseEndSeq)
  }

  markCommittedThrough(
    identity: PtyOwnershipTransferWireIdentity,
    throughSeq: number
  ): PtyOwnershipTransferDestinationOutputSnapshot {
    return this.options.outbox.markCommittedThrough(identity, throughSeq)
  }

  /** Durably enqueue a frame without publishing it to the destination surface yet. */
  stage(
    identity: PtyOwnershipTransferWireIdentity,
    frame: PtyOwnershipTransferOutputFrame
  ): PtyOwnershipTransferDestinationOutputSnapshot {
    this.options.outbox.stage(identity, frame)
    const snapshot = this.options.outbox.load(identity)
    if (!snapshot) {
      throw new Error('pty_ownership_transfer_output_sink_not_open')
    }
    return snapshot
  }

  publish(
    identity: PtyOwnershipTransferWireIdentity,
    surfaceBinding: PtyOwnershipTransferSurfaceBinding,
    frame: PtyOwnershipTransferOutputFrame
  ): PtyOwnershipTransferDestinationOutputSnapshot {
    const disposition = this.options.outbox.enqueue(identity, frame)
    if (disposition !== 'acknowledged') {
      const acknowledgement = this.options.deliver(identity, surfaceBinding, frame)
      assertAcknowledgement(acknowledgement, identity, frame.seq)
      this.options.outbox.acknowledge(identity, acknowledgement.throughSeq)
    }
    const snapshot = this.options.outbox.load(identity)
    if (!snapshot) {
      throw new Error('pty_ownership_transfer_output_sink_not_open')
    }
    return snapshot
  }

  drain(
    identity: PtyOwnershipTransferWireIdentity,
    surfaceBinding: PtyOwnershipTransferSurfaceBinding
  ): PtyOwnershipTransferDestinationOutputSnapshot | null {
    let snapshot = this.options.outbox.load(identity)
    if (!snapshot) {
      return null
    }
    for (const frame of snapshot.pendingFrames) {
      // A cumulative acknowledgement may cover later frames in the original snapshot.
      if (frame.seq <= snapshot.acknowledgedEndSeq) {
        continue
      }
      const acknowledgement = this.options.deliver(identity, surfaceBinding, frame)
      assertAcknowledgement(acknowledgement, identity, frame.seq)
      snapshot = this.options.outbox.acknowledge(identity, acknowledgement.throughSeq)
    }
    return snapshot
  }
}

function assertAcknowledgement(
  acknowledgement: PtyOwnershipTransferOutputAcknowledgement,
  expectedIdentity: PtyOwnershipTransferWireIdentity,
  minimumSeq: number
): void {
  if (
    !acknowledgement ||
    !isTransferIdentity(acknowledgement.identity) ||
    !samePtyOwnershipTransferIdentity(acknowledgement.identity, expectedIdentity) ||
    !Number.isSafeInteger(acknowledgement.throughSeq) ||
    acknowledgement.throughSeq < minimumSeq
  ) {
    throw new Error('pty_ownership_transfer_output_sink_ack_invalid')
  }
}

function isTransferIdentity(value: unknown): value is PtyOwnershipTransferWireIdentity {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const record = value as Record<string, unknown>
  return (
    typeof record.bridgeId === 'string' &&
    typeof record.terminalId === 'string' &&
    typeof record.incarnationId === 'string' &&
    typeof record.ownerLease === 'string' &&
    Number.isSafeInteger(record.sourceOwnerGeneration) &&
    typeof record.destinationRuntimeId === 'string'
  )
}
