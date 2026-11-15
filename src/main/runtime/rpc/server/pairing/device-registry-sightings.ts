import { withDeviceSighting, type DeviceSightingFraming } from './device-sighting'
import { DeviceRegistryStore } from './device-registry-store'
import type { DeviceEntry } from './device-entry'
import type { NetworkSourceClass } from '../../transports/websocket/source-admission/network-source-class'
import { DeviceRegistryUnavailableError } from './device-registry-unavailable'

// Coalesce reconnect bookkeeping: each Windows save otherwise spawns synchronous ACL PowerShell twice.
const LAST_SEEN_FLUSH_DELAY_MS = 250
/** Device sightings: last-seen bookkeeping, persisted inline on a first sighting and coalesced after. */
export class DeviceRegistrySightings extends DeviceRegistryStore {
  protected get seenDeviceIds(): ReadonlySet<string> {
    return new Set(this.devices.filter((row) => row.lastSeenAt > 0).map((row) => row.deviceId))
  }

  updateLastSeen(
    deviceId: string,
    sourceClass?: NetworkSourceClass,
    framing?: DeviceSightingFraming
  ): void {
    // Persist first sighting inline or rotation could delete a paired row still pending on disk.
    const before = this.devices.find((row) => row.deviceId === deviceId)
    if (!before) {
      return
    }
    const authority = this.authorityIndex.capture({
      deviceId,
      credentialRevision: before.credentialRevision ?? 0,
      ...(before.token ? { deviceToken: before.token } : {})
    })
    const seenAt = Date.now()
    const sight = ({ offerExpiresAt: _paired, ...device }: DeviceEntry): DeviceEntry => {
      const firstSighting =
        device.lastSeenAt === 0
          ? { ...device, ticketFirstSeenAt: device.ticketFirstSeenAt ?? seenAt }
          : device
      return withDeviceSighting(seen(firstSighting, seenAt, sourceClass), seenAt, framing)
    }
    try {
      this.requireAuthority({ fresh: true })
      if (!authority || authority.signal.aborted) {
        throw new Error('unauthorized')
      }
      if (!this.replaceRow(deviceId, sight, { durable: true })) {
        throw new Error('unauthorized')
      }
    } catch (error) {
      if (
        error instanceof DeviceRegistryUnavailableError &&
        error.reason === 'io' &&
        !authority?.signal.aborted
      ) {
        this.retainFirstSighting(before, sight(before))
      }
      throw error
    }
  }

  /** Defer repeat sightings to avoid synchronous Windows ACL saves during E2EE auth.
   * First sighting must persist inline so pending-offer rotation cannot revoke a paired device. */
  updateLastSeenDeferred(
    deviceId: string,
    sourceClass?: NetworkSourceClass,
    framing?: DeviceSightingFraming
  ): void {
    const existing = this.devices.find((d) => d.deviceId === deviceId)
    if (!existing || existing.lastSeenAt === 0 || this.needsFirstSightingSave(deviceId)) {
      return existing ? this.updateLastSeen(deviceId, sourceClass, framing) : undefined
    }
    const seenAt = Date.now()
    this.updateSighting(
      deviceId,
      withDeviceSighting(seen(existing, seenAt, sourceClass), seenAt, framing)
    )
    this.scheduleLastSeenFlush(LAST_SEEN_FLUSH_DELAY_MS)
  }

  private scheduleLastSeenFlush(delayMs: number): void {
    if (!this.pendingLastSeenFlush) {
      this.pendingLastSeenFlush = setTimeout(() => this.flushPendingLastSeen(), delayMs)
      this.pendingLastSeenFlush.unref?.()
    }
  }

  flushPendingLastSeen(): void {
    if (!this.pendingLastSeenFlush) {
      return
    }
    this.cancelPendingLastSeenFlush()
    // Failed bookkeeping must not terminate the runtime.
    try {
      this.devices = this.save(this.devices)
    } catch (error) {
      console.error('[runtime] Failed to persist device lastSeen:', error)
    }
  }
}

function seen(device: DeviceEntry, seenAt: number, sourceClass?: NetworkSourceClass): DeviceEntry {
  return { ...device, lastSeenAt: seenAt, ...(sourceClass ? { lastSourceClass: sourceClass } : {}) }
}
