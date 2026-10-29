import { writeDurableSecureJsonFile, writeSecureJsonFile } from '../../shared/secure-file'
import type { DeviceEntry } from './device-entry'
import { readDeviceRegistryFile, type DeviceRegistryFileRead } from './device-registry-file-read'

/**
 * What a save may write over the file as it is now on disk. Another writer (an admin removing a
 * device, the pairing CLI adding one) may have changed it since this process loaded it, so:
 * - a row this process knew of that is gone from disk stays gone, never resurrected from memory;
 * - rows this save adds, and this save's version of rows still on disk, are kept;
 * - rows that appeared on disk since are kept, unless this process ever removed them: `removed`
 *   holds those ids, so a stale writer putting a revoked row back can't get it adopted.
 */
export function mergeDeviceRegistrySave(
  before: readonly DeviceEntry[],
  next: readonly DeviceEntry[],
  disk: DeviceRegistryFileRead,
  removed: ReadonlySet<string> = new Set()
): DeviceEntry[] {
  const known = new Set([...before.map((device) => device.deviceId), ...removed])
  const onDisk = new Set(disk.devices.map((device) => device.deviceId))
  const saving = new Set(next.map((device) => device.deviceId))
  return [
    ...next.filter((device) => onDisk.has(device.deviceId) || !known.has(device.deviceId)),
    ...disk.devices.filter((device) => !known.has(device.deviceId) && !saving.has(device.deviceId))
  ]
}

/**
 * Writes saves merged over the file as it is now (atomically, through the secure-file stage and
 * rename). Remembers every id this process removed, recorded before the write so a failed save
 * (such as the load-time cleanup of session-only rows) still counts: a stale writer putting one of
 * those back must not get it re-adopted. A file that became unreadable or corrupt proves nothing
 * about removals, so then the save is written as is, as before.
 */
export class DeviceRegistryWriter {
  private readonly removedIds = new Set<string>()

  constructor(private readonly registryPath: string) {}

  /** Returns what was written. Security transitions pass `durable`. */
  write(
    before: readonly DeviceEntry[],
    next: readonly DeviceEntry[],
    options: { durable?: boolean } = {}
  ): DeviceEntry[] {
    const saving = new Set(next.map((device) => device.deviceId))
    for (const { deviceId } of before) {
      if (!saving.has(deviceId)) {
        this.removedIds.add(deviceId)
      }
    }
    const disk = readDeviceRegistryFile(this.registryPath)
    const merged =
      disk.unreadable || disk.corruptFilePending
        ? [...next]
        : mergeDeviceRegistrySave(before, next, disk, this.removedIds)
    const write = options.durable ? writeDurableSecureJsonFile : writeSecureJsonFile
    write(this.registryPath, merged)
    return merged
  }
}
