import { join } from 'node:path'
import { removeStaleDurableWriteTempFiles } from '../../../../filesystem/durable-file-write'
import { DEVICE_REGISTRY_FILENAME } from './mobile-pairing-files'
import { withoutEphemeralRows } from './ephemeral-device-rows'
import { DeviceRegistryWriter } from './device-registry-disk-merge'
import type { DeviceEntry } from './device-entry'
import { DeviceAuthorityIndex } from './device-authority-index'

const STALE_WRITE_TEMP_AGE_MS = 24 * 60 * 60 * 1000

/** Registry persistence: every change is written merged over the file before memory takes it. */
export class DeviceRegistryStore {
  private readonly registryPath: string
  private deviceRows: DeviceEntry[] = []
  protected readonly authorityIndex = new DeviceAuthorityIndex()
  protected get devices(): DeviceEntry[] {
    return this.deviceRows
  }
  protected set devices(devices: DeviceEntry[]) {
    if (devices !== this.deviceRows) {
      this.deviceRows = devices
      this.authorityIndex.publish(devices)
    }
  }
  protected updateSighting(
    deviceId: string,
    sighting: Pick<DeviceEntry, 'lastSeenAt' | 'lastSourceClass' | 'legacyE2EEAuthAt'>
  ): void {
    const previous = this.authorityIndex.row(deviceId)
    if (!previous) {
      return
    }
    const updated = {
      ...previous,
      lastSeenAt: sighting.lastSeenAt,
      lastSourceClass: sighting.lastSourceClass,
      legacyE2EEAuthAt: sighting.legacyE2EEAuthAt
    }
    this.deviceRows = this.deviceRows.map((device) =>
      device.deviceId === deviceId ? updated : device
    )
    this.authorityIndex.updateSighting(updated)
  }

  /** Never overwrite an unreadable registry from the empty in-memory list. */
  protected registryUnreadable = false
  /** Parse failures prevent authoritative absence/revocation verdicts. */
  protected registryDoubtful = false
  private corruptFilePending = false
  protected pendingLastSeenFlush: NodeJS.Timeout | null = null
  private readonly writer: DeviceRegistryWriter

  constructor(userDataPath: string) {
    this.registryPath = join(userDataPath, DEVICE_REGISTRY_FILENAME)
    this.writer = new DeviceRegistryWriter(this.registryPath)
    // #20497: reap temp files orphaned by a crash before rename.
    void removeStaleDurableWriteTempFiles(this.registryPath, {
      minimumAgeMs: STALE_WRITE_TEMP_AGE_MS
    })
    this.load()
  }

  protected saveOrLog(
    options: { durable?: boolean },
    action: string,
    before = this.devices,
    next = this.devices
  ): void {
    try {
      this.devices = this.save(next, options, before)
    } catch (error) {
      console.error(`[runtime] Failed to ${action}:`, error)
    }
  }

  protected cancelPendingLastSeenFlush(): void {
    if (this.pendingLastSeenFlush) {
      clearTimeout(this.pendingLastSeenFlush)
      this.pendingLastSeenFlush = null
    }
  }

  /** Auth checks see a disk removal (an admin revoke) within a second; `fresh` planners see it now. */
  protected adoptExternalEdits(options: { fresh?: boolean } = {}): void {
    // An unreadable load refuses everything until restart; there is nothing to merge into.
    if (!this.registryUnreadable) {
      this.devices = this.writer.adoptExternalEdits(this.devices, options) ?? this.devices
    }
  }

  /** The socket owner refreshes even when no caller submits another request. */
  refreshAuthority(): void {
    this.adoptExternalEdits()
    this.authorityIndex.expire(this.devices)
  }

  /** A stopped observer cannot continue authorizing its captured sockets or queued work. */
  retireCapturedAuthority(): void {
    this.authorityIndex.publish(this.devices, Date.now(), true)
  }

  private load(): void {
    const read = this.writer.read()
    this.registryUnreadable = read.unreadable
    this.registryDoubtful = read.doubtful
    this.corruptFilePending = read.corruptFilePending
    this.devices = withoutEphemeralRows(read.devices)
    // Session-only browser keys died with the prior host; remove their registry rows.
    if (this.devices.length !== read.devices.length) {
      this.saveOrLog({ durable: true }, 'drop session-only devices after restart', read.devices)
    }
  }

  // Persist before memory swap so failed writes cannot diverge authorization state.
  protected replaceRow(deviceId: string, update: (device: DeviceEntry) => DeviceEntry): boolean {
    const index = this.devices.findIndex((candidate) => candidate.deviceId === deviceId)
    if (index === -1) {
      return false
    }
    const nextDevices = this.devices.map((device, candidateIndex) =>
      candidateIndex === index ? update(device) : device
    )
    this.devices = this.save(nextDevices)
    // False when the file had already lost the row: the update did not apply.
    return this.devices.some((candidate) => candidate.deviceId === deviceId)
  }

  private assertReadable(): void {
    if (this.registryUnreadable) {
      throw new Error(
        `Cannot read the device registry at ${this.registryPath}: the read failed. Refusing to overwrite it, which would revoke every paired device.`
      )
    }
    if (this.corruptFilePending) {
      this.writer.quarantineCorrupt()
      this.corruptFilePending = false
    }
  }

  /** Writes `devices` merged over the file as it is now; memory takes the result. */
  protected save(
    devices: readonly DeviceEntry[],
    options: { durable?: boolean } = {},
    before: readonly DeviceEntry[] = this.devices
  ): DeviceEntry[] {
    this.assertReadable()
    const written = this.writer.write(before, devices, options)
    // Every save includes current timestamps, making a pending refresh redundant.
    this.cancelPendingLastSeenFlush()
    return written
  }
}
