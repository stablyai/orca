import { withDeviceSighting, type DeviceSightingFraming } from './device-sighting'
import { DeviceRegistryStore } from './device-registry-store'
import type { DeviceEntry } from './device-entry'
import type { NetworkSourceClass } from '../../transports/websocket/source-admission/network-source-class'

// Coalesce reconnect bookkeeping: each Windows save otherwise spawns synchronous ACL PowerShell twice.
const LAST_SEEN_FLUSH_DELAY_MS = 250
// Unpersisted, a restart would refuse and prune a signed-in row as an expired unused offer.
const FIRST_SIGHTING_RETRY_MS = 60_000

/** Device sightings: last-seen bookkeeping, persisted inline on a first sighting and coalesced after. */
export class DeviceRegistrySightings extends DeviceRegistryStore {
  /** First sightings this session, kept even when their persist failed. */
  protected readonly seenDeviceIds = new Set<string>()
  private firstSightingRetryPending = false

  updateLastSeen(
    deviceId: string,
    sourceClass?: NetworkSourceClass,
    framing?: DeviceSightingFraming
  ): void {
    // Persist first sighting inline or rotation could delete a paired row still pending on disk.
    this.seenDeviceIds.add(deviceId)
    const seenAt = Date.now()
    const sight = ({ offerExpiresAt: _paired, ...device }: DeviceEntry): DeviceEntry => {
      const firstSighting =
        device.ticket === true && device.lastSeenAt === 0
          ? { ...device, ticketFirstSeenAt: seenAt }
          : device
      return withDeviceSighting(seen(firstSighting, seenAt, sourceClass), seenAt, framing)
    }
    try {
      this.replaceRow(deviceId, sight)
    } catch (error) {
      // Keep the sighting in memory so any later save writes it, and retry until one lands.
      this.devices = this.devices.map((d) => (d.deviceId === deviceId ? sight(d) : d))
      this.firstSightingRetryPending = true
      this.scheduleLastSeenFlush(FIRST_SIGHTING_RETRY_MS)
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
    if (!existing || existing.lastSeenAt === 0) {
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
      this.firstSightingRetryPending = false
    } catch (error) {
      console.error('[runtime] Failed to persist device lastSeen:', error)
      if (this.firstSightingRetryPending) {
        this.scheduleLastSeenFlush(FIRST_SIGHTING_RETRY_MS)
      }
    }
  }
}

function seen(device: DeviceEntry, seenAt: number, sourceClass?: NetworkSourceClass): DeviceEntry {
  return { ...device, lastSeenAt: seenAt, ...(sourceClass ? { lastSourceClass: sourceClass } : {}) }
}
