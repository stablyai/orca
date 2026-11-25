import {
  NOTIFICATION_COOLDOWN_MS,
  reserveNotificationCooldown
} from '../../../shared/notifications/notification-burst-cooldown'
import type { NotificationPushCoverageRequest } from '../../../shared/rpc-contract/notifications/notifications-params'

// Keyed news is announced once by its producer, so only its own repeat may collapse it.
export function pushBurstSubject(event: { attentionKey?: string; worktreeId?: string }): string {
  return event.attentionKey ?? event.worktreeId ?? 'global'
}

function slotKey(deviceId: string, subject: string): string {
  return JSON.stringify([deviceId, subject])
}

/** How a mirroring host reads a mirrored session's execution host's burst slots. */
export type ExecutionHostPushCoverage = {
  /** Token digests of phones the execution host already pushed; empty when it can't say. */
  ask: (
    executionHost: string,
    request: NotificationPushCoverageRequest
  ) => Promise<ReadonlySet<string>>
}

type SlotDevice = { deviceId: string; pushRegistration?: { tokenDigest?: string } }

function askedDevices(
  devices: readonly SlotDevice[],
  request: NotificationPushCoverageRequest
): { deviceId: string; digest: string }[] {
  const asked = new Set(request.tokenDigests)
  return devices.flatMap(({ deviceId, pushRegistration }) => {
    const digest = pushRegistration?.tokenDigest
    return digest && asked.has(digest) ? [{ deviceId, digest }] : []
  })
}

/** One push per phone and subject per cooldown, whichever host's push the gateway took first. */
export class PushBurstSlots {
  private readonly reservedAt = new Map<string, number>()
  // Per held slot: the token digest of the phone registration the gateway took its push for.
  private readonly deliveries = new Map<string, Promise<string | undefined>>()

  /** The slot this push holds, or null while an earlier push holds it. */
  reserve(deviceId: string, subject: string, at: number): string | null {
    const slot = slotKey(deviceId, subject)
    if (!reserveNotificationCooldown(this.reservedAt, slot, at)) {
      return null
    }
    this.deliveries.delete(slot)
    // Bounded by the cooldown map, which forgets expired slots.
    for (const key of this.deliveries.keys()) {
      if (!this.reservedAt.has(key)) {
        this.deliveries.delete(key)
      }
    }
    return slot
  }

  recordDelivery(slot: string, deliveredDigest: Promise<string | undefined>): void {
    this.deliveries.set(slot, deliveredDigest)
  }

  /** Of the asked phones, those a push the gateway took holds the subject's slot for. */
  async coveredDigests(
    devices: readonly SlotDevice[],
    request: NotificationPushCoverageRequest,
    now: number
  ): Promise<string[]> {
    const answers = askedDevices(devices, request).map(async ({ deviceId, digest }) => {
      const slot = slotKey(deviceId, request.subject)
      const at = this.reservedAt.get(slot)
      const held = at !== undefined && now - at < NOTIFICATION_COOLDOWN_MS
      return held && (await this.deliveries.get(slot)) === digest ? [digest] : []
    })
    return (await Promise.all(answers)).flat()
  }
}
