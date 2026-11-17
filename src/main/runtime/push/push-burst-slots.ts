import { reserveNotificationCooldown } from '../../../shared/notifications/notification-burst-cooldown'

// Keyed news is announced once by its producer, so only its own repeat may collapse it.
export function pushBurstSubject(event: { attentionKey?: string; worktreeId?: string }): string {
  return event.attentionKey ?? event.worktreeId ?? 'global'
}

function slotKey(deviceId: string, subject: string): string {
  return JSON.stringify([deviceId, subject])
}

/** One push per phone and subject per cooldown, shared with a mirroring host that asks about it. */
export class PushBurstSlots {
  private readonly reservedAt = new Map<string, number>()
  // Per slot this host pushed itself: whether the gateway took it.
  private readonly deliveries = new Map<string, Promise<boolean>>()

  /** The slot this push holds, or null while an earlier push holds it. */
  reserve(deviceId: string, subject: string, at: number): string | null {
    const slot = slotKey(deviceId, subject)
    return reserveNotificationCooldown(this.reservedAt, slot, at) ? slot : null
  }

  recordDelivery(slot: string, delivered: Promise<boolean>): void {
    this.deliveries.delete(slot)
    this.deliveries.set(slot, delivered)
    // Bounded by the cooldown map, which forgets expired slots.
    for (const key of this.deliveries.keys()) {
      if (!this.reservedAt.has(key)) {
        this.deliveries.delete(key)
      }
    }
  }

  /** Whether the phone got this subject's push from here; a free slot is the asking host's instead. */
  async coveredForMirror(deviceId: string, subject: string, now: number): Promise<boolean> {
    const slot = this.reserve(deviceId, subject, now)
    if (slot) {
      this.deliveries.delete(slot)
      return false
    }
    // A slot without a delivery of ours was taken for another host, which pushed it.
    return (await this.deliveries.get(slotKey(deviceId, subject))) ?? true
  }
}
