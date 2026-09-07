import {
  ptySourceDeliveryKey,
  type PtySourceDeliveryIdentity
} from '../shared/pty-source-credit-contract'
import type {
  RelayPtySourceCreditLedger,
  PtySourceSendReservation
} from './pty-source-credit-ledger'

export const PTY_SOURCE_SCHEDULER_MAX_FRAMES = 2
export const PTY_SOURCE_SCHEDULER_MAX_SU = 32 * 1024

export class RelayPtySourceCreditScheduler {
  private readonly identities = new Map<string, PtySourceDeliveryIdentity>()
  private readonly readyKeys: string[] = []
  private readonly queuedKeys = new Set<string>()

  constructor(private readonly ledger: RelayPtySourceCreditLedger) {}

  enqueue(identity: PtySourceDeliveryIdentity): void {
    const key = ptySourceDeliveryKey(identity)
    this.identities.set(key, identity)
    if (!this.queuedKeys.has(key)) {
      this.queuedKeys.add(key)
      this.readyKeys.push(key)
    }
  }

  remove(identity: PtySourceDeliveryIdentity): void {
    const key = ptySourceDeliveryKey(identity)
    this.identities.delete(key)
    this.queuedKeys.delete(key)
    for (let index = this.readyKeys.length - 1; index >= 0; index--) {
      if (this.readyKeys[index] === key) {
        this.readyKeys.splice(index, 1)
      }
    }
  }

  takeTurn(
    maxFrames = PTY_SOURCE_SCHEDULER_MAX_FRAMES,
    maxSourceSu = PTY_SOURCE_SCHEDULER_MAX_SU
  ): PtySourceSendReservation[] {
    const reservations: PtySourceSendReservation[] = []
    let remainingKeys = this.readyKeys.length
    let admittedSu = 0
    while (remainingKeys-- > 0 && reservations.length < maxFrames && admittedSu < maxSourceSu) {
      const key = this.readyKeys.shift()!
      this.queuedKeys.delete(key)
      const identity = this.identities.get(key)
      if (!identity) {
        continue
      }
      let reservation: PtySourceSendReservation | null
      try {
        reservation = this.ledger.reserveNextSend(identity, maxSourceSu - admittedSu)
      } catch {
        this.identities.delete(key)
        continue
      }
      this.enqueue(identity)
      if (!reservation) {
        continue
      }
      reservations.push(reservation)
      admittedSu += reservation.span.sourceEndSu - reservation.span.sourceStartSu
    }
    return reservations
  }
}
