import type { RelayDispatcher } from './dispatcher'
import type {
  PtyOwnershipTransferWireIdentity,
  PtyOwnershipTransferOutputFrame
} from '../shared/pty-ownership-transfer-wire'
import type { PtyOwnershipTransferDestinationClaim } from '../shared/pty-ownership-transfer-destination-claim'
import { PtyOwnershipTransferOutputCreditWindow } from '../shared/pty-ownership-transfer-output-credit'

import { RELAY_PTY_DESTINATION_OUTPUT_NOTIFICATION } from '../shared/pty-ownership-transfer-destination-output-wire'
export { RELAY_PTY_DESTINATION_OUTPUT_NOTIFICATION } from '../shared/pty-ownership-transfer-destination-output-wire'

/** One claim-bound producer lane; journal retention remains authoritative for reconnect replay. */
export class RelayPtyOwnershipTransferDestinationOutputRoute {
  private readonly credit: PtyOwnershipTransferOutputCreditWindow
  private pending?: Readonly<PtyOwnershipTransferOutputFrame>
  private publishedThroughSeq = 0
  private publishing = false
  private disposed = false
  private readonly identity: PtyOwnershipTransferWireIdentity
  private readonly claim: PtyOwnershipTransferDestinationClaim

  constructor(
    private readonly options: {
      dispatcher: Pick<RelayDispatcher, 'publishProducerNotification'>
      clientId: number
      identity: PtyOwnershipTransferWireIdentity
      claim: PtyOwnershipTransferDestinationClaim
      isActive: () => boolean
      windowBytes: number
      windowFrames?: number
    }
  ) {
    this.options = Object.freeze({ ...options })
    this.identity = Object.freeze({ ...options.identity })
    this.claim = Object.freeze({ ...options.claim })
    this.credit = new PtyOwnershipTransferOutputCreditWindow(
      options.windowBytes,
      options.windowFrames
    )
  }

  /** False leaves the frame with the journal producer; one admitted-but-unsent frame is retained. */
  publish(frame: PtyOwnershipTransferOutputFrame): boolean {
    if (!this.active() || this.publishing) {
      return false
    }
    if (this.pending) {
      if (this.pending.seq !== frame.seq) {
        return false
      }
      if (this.pending.data !== frame.data || frame.truncated) {
        throw new Error('pty_ownership_transfer_destination_output_conflict')
      }
    } else {
      const admission = this.credit.admit(frame)
      if (admission === 'capacity') {
        return false
      }
      if (admission === 'duplicate') {
        return true
      }
      this.pending = Object.freeze({ ...frame })
    }
    return this.flush()
  }

  /** Called by the owner's existing capacity scheduler; no per-frame promises or timers. */
  flush(): boolean {
    if (!this.active() || this.publishing) {
      return false
    }
    const frame = this.pending
    if (!frame) {
      return true
    }
    this.publishing = true
    try {
      const sent = this.options.dispatcher.publishProducerNotification(
        this.options.clientId,
        RELAY_PTY_DESTINATION_OUTPUT_NOTIFICATION,
        { ...this.identity, version: 1, destinationClaim: this.claim, frame },
        { logDrop: false }
      )
      if (!sent) {
        return false
      }
      this.publishedThroughSeq = frame.seq
      this.pending = undefined
      return true
    } finally {
      this.publishing = false
    }
  }

  acknowledge(throughSeq: number) {
    if (!this.active() || this.publishing) {
      throw new Error('pty_ownership_transfer_destination_output_route_stale')
    }
    if (throughSeq > this.publishedThroughSeq) {
      throw new Error('pty_ownership_transfer_destination_output_ack_unsent')
    }
    return this.credit.acknowledge(throughSeq)
  }

  dispose(): void {
    this.disposed = true
    this.pending = undefined
  }

  isAvailable(): boolean {
    return this.active() && !this.publishing
  }

  private active(): boolean {
    return !this.disposed && this.options.isActive()
  }
}
