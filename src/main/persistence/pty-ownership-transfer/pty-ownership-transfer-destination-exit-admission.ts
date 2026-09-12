import type {
  PtyOwnershipTransferDestinationAttachmentReservation,
  PtyOwnershipTransferDestinationAdapter
} from '../../../shared/pty-ownership-transfer-destination-adapter'
import type { PtyOwnershipTransferExitEvent } from '../../../shared/pty-ownership-transfer-wire'

type PendingExitAdmission = {
  reservation: PtyOwnershipTransferDestinationAttachmentReservation
  event?: PtyOwnershipTransferExitEvent
}

/** Buffers authoritative exit evidence while an attachment reservation is not yet live. */
export class PtyOwnershipTransferDestinationExitAdmission {
  private readonly pending = new Map<string, PendingExitAdmission>()

  begin(reservation: PtyOwnershipTransferDestinationAttachmentReservation): void {
    this.pending.set(reservation.bridgeId, { reservation })
  }

  acceptOrBuffer(
    adapter: PtyOwnershipTransferDestinationAdapter,
    event: PtyOwnershipTransferExitEvent,
    reservation?: PtyOwnershipTransferDestinationAttachmentReservation
  ): void {
    const snapshot = adapter.snapshot()
    if (snapshot.attachmentId === event.attachmentId) {
      adapter.acceptExit(event)
      return
    }
    const pending = this.pending.get(event.bridgeId)
    if (
      !reservation ||
      !pending ||
      pending.reservation !== reservation ||
      reservation.attachmentId !== event.attachmentId
    ) {
      return
    }
    if (pending.event && JSON.stringify(pending.event) !== JSON.stringify(event)) {
      throw new Error('pty_ownership_transfer_pending_exit_conflict')
    }
    pending.event = structuredClone(event)
  }

  settle(
    reservation: PtyOwnershipTransferDestinationAttachmentReservation,
    adapter: PtyOwnershipTransferDestinationAdapter
  ): void {
    const pending = this.pending.get(reservation.bridgeId)
    if (!pending || pending.reservation !== reservation) {
      return
    }
    this.pending.delete(reservation.bridgeId)
    if (pending.event) {
      adapter.acceptExit(pending.event)
    }
  }

  cancel(reservation?: PtyOwnershipTransferDestinationAttachmentReservation): void {
    if (!reservation) {
      return
    }
    const pending = this.pending.get(reservation.bridgeId)
    if (pending?.reservation === reservation) {
      this.pending.delete(reservation.bridgeId)
    }
  }
}
