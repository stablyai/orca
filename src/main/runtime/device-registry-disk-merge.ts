import { statSync } from 'node:fs'
import { writeDurableSecureJsonFile, writeSecureJsonFile } from '../../shared/secure-file'
import type { DeviceEntry } from './device-entry'
import { isMissingFileError, quarantineCorruptRegistry } from './device-registry-corruption'
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
 * those back must not get it re-adopted. A file that became unreadable or corrupt, or that this
 * process quarantined itself, proves nothing about removals, so then the save is written as is.
 */
export class DeviceRegistryWriter {
  private readonly removedIds = new Set<string>()
  /** This process moved the file aside and no write has landed since: its absence is ours, not a revoke. */
  private quarantinedUntilWritten = false
  /** Stat identity of the file when this process last read it; null forces the next re-read. */
  private readStamp: string | null = null

  constructor(private readonly registryPath: string) {}

  quarantineCorrupt(): void {
    if (quarantineCorruptRegistry(this.registryPath)) {
      this.quarantinedUntilWritten = true
    }
  }

  /** Stamped before reading, so a write landing during the read is caught by the next check. */
  read(): DeviceRegistryFileRead {
    this.readStamp = fileStamp(this.registryPath)
    return readDeviceRegistryFile(this.registryPath)
  }

  /**
   * `current` merged over the file when another writer changed it since this process last read it,
   * else null. Costs one stat when unchanged. An unreadable or corrupt file, or our own quarantine's
   * absence, proves nothing about removals, so it changes nothing.
   */
  adoptExternalEdits(current: readonly DeviceEntry[]): DeviceEntry[] | null {
    if (this.quarantinedUntilWritten || fileStamp(this.registryPath) === this.readStamp) {
      return null
    }
    const disk = this.read()
    return disk.unreadable || disk.corruptFilePending
      ? null
      : mergeDeviceRegistrySave(current, current, disk, this.removedIds)
  }

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
    const disk = this.quarantinedUntilWritten ? null : readDeviceRegistryFile(this.registryPath)
    const merged =
      !disk || disk.unreadable || disk.corruptFilePending
        ? [...next]
        : mergeDeviceRegistrySave(before, next, disk, this.removedIds)
    const write = options.durable ? writeDurableSecureJsonFile : writeSecureJsonFile
    // Stat after our rename can't tell our write from one right after it; re-read once instead.
    this.readStamp = null
    write(this.registryPath, merged)
    this.quarantinedUntilWritten = false
    return merged
  }
}

function fileStamp(registryPath: string): string {
  try {
    const stat = statSync(registryPath, { bigint: true })
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`
  } catch (error) {
    // Never equal to a real stamp, so the file appearing or vanishing is noticed.
    return isMissingFileError(error) ? 'missing' : 'unstattable'
  }
}
