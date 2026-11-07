import { readFileSync, statSync } from 'node:fs'
import { writeDurableSecureJsonFile, writeSecureJsonFile } from '../../../../../shared/secure-file'
import type { DeviceEntry } from './device-entry'
import { isMissingFileError, quarantineCorruptRegistry } from './device-registry-corruption'
import { readDeviceRegistryFile, type DeviceRegistryFileRead } from './device-registry-file-read'

// Phones recheck auth on every frame and request; one stat a second bounds a disk revoke's lag.
const EXTERNAL_EDIT_CHECK_INTERVAL_MS = 1000
// Another writer landed between our read and rename: re-read and re-merge, a few times at most.
const MAX_WRITE_ATTEMPTS = 5
// Non-atomic external writers (an admin's script) can be caught mid-write; give them a moment.
const TORN_READ_RETRY_MS = 25

/**
 * What a save may write over the file as it is now on disk. Another writer (an admin removing a
 * device, the pairing CLI adding one) may have changed it since this process loaded it, so:
 * - a row this process knew of that is gone from disk stays gone, never resurrected from memory;
 * - rows this save adds, and this save's version of rows still on disk, are kept;
 * - rows that appeared on disk since are kept, unless this process ever removed them: `removed`
 *   holds those ids, so a stale writer putting a revoked row back can't get it adopted;
 * - a sighting never goes backwards, so a stale writer cannot turn a paired row back into an
 *   unscanned (expirable, rotatable) offer.
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
  const diskLastSeen = new Map(disk.devices.map((device) => [device.deviceId, device.lastSeenAt]))
  return [
    ...next
      .filter((device) => onDisk.has(device.deviceId) || !known.has(device.deviceId))
      .map((device) => withLatestSighting(device, diskLastSeen.get(device.deviceId))),
    ...disk.devices.filter((device) => !known.has(device.deviceId) && !saving.has(device.deviceId))
  ]
}

function withLatestSighting(device: DeviceEntry, diskLastSeenAt: number | undefined): DeviceEntry {
  return diskLastSeenAt !== undefined && diskLastSeenAt > device.lastSeenAt
    ? { ...device, lastSeenAt: diskLastSeenAt }
    : device
}

/**
 * Writes saves merged over the file as it is now (atomically, through the secure-file stage and
 * rename). Remembers every id this process removed, recorded before the write so a failed save
 * (such as the load-time cleanup of session-only rows) still counts: a stale writer putting one of
 * those back must not get it re-adopted. A file that became unreadable or corrupt proves nothing
 * about removals, so then the save is written as is; after this process's own quarantine, the save
 * keeps only rows another writer added since.
 */
export class DeviceRegistryWriter {
  private readonly removedIds = new Set<string>()
  /** This process moved the file aside and no write has landed since: its absence is ours, not a revoke. */
  private quarantinedUntilWritten = false
  /** Stat identity of the file when this process last read it; null forces the next re-read. */
  private readStamp: string | null = null
  private checkedAt = Number.NEGATIVE_INFINITY

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
   * else null. Stats at most once per interval unless `fresh` or right after our own save. An
   * unreadable or corrupt file, or our own quarantine's absence, proves nothing about removals, so
   * it changes nothing.
   */
  adoptExternalEdits(
    current: readonly DeviceEntry[],
    options: { fresh?: boolean } = {}
  ): DeviceEntry[] | null {
    if (this.quarantinedUntilWritten) {
      return null
    }
    const now = performance.now()
    if (
      !options.fresh &&
      this.readStamp !== null &&
      now - this.checkedAt < EXTERNAL_EDIT_CHECK_INTERVAL_MS
    ) {
      return null
    }
    this.checkedAt = now
    if (fileStamp(this.registryPath) === this.readStamp) {
      return null
    }
    const disk = this.read()
    return disk.unreadable || disk.corruptFilePending
      ? null
      : mergeDeviceRegistrySave(current, current, disk, this.removedIds)
  }

  /**
   * Returns what was written. Security transitions pass `durable`. The merge is published only if
   * the file is still exactly what it was read from (compare-and-swap); otherwise another writer
   * landed in between, so the save re-reads and re-merges. Without that, a save that read the file
   * before an admin's revoke and renamed after it would put the revoked row back.
   */
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
    // Stat after our rename can't tell our write from one right after it; re-read once instead.
    this.readStamp = null
    for (let attempt = 1; ; attempt++) {
      const lastAttempt = attempt >= MAX_WRITE_ATTEMPTS
      const snapshot = readRawRegistry(this.registryPath)
      const disk = readDeviceRegistryFile(this.registryPath)
      if (
        disk.corruptFilePending &&
        !lastAttempt &&
        snapshot !== readRawRegistry(this.registryPath)
      ) {
        // Still being written by someone else; a torn read proves nothing, so wait and re-read.
        sleepSync(TORN_READ_RETRY_MS)
        continue
      }
      // After our own quarantine the file's absence is no removal evidence, but rows another writer
      // (the pairing CLI) added since are still kept: merge with no known baseline.
      const baseline = this.quarantinedUntilWritten ? [] : before
      const merged =
        disk.unreadable || disk.corruptFilePending
          ? [...next]
          : mergeDeviceRegistrySave(baseline, next, disk, this.removedIds)
      let unchanged = true
      const write = options.durable ? writeDurableSecureJsonFile : writeSecureJsonFile
      write(this.registryPath, merged, {
        // Last check before the rename; a lost race discards the stage and merges again.
        shouldPublish: () =>
          (unchanged = lastAttempt || readRawRegistry(this.registryPath) === snapshot)
      })
      if (unchanged) {
        this.quarantinedUntilWritten = false
        return merged
      }
    }
  }
}

/** Raw file text for compare-and-swap; null when absent, and a marker no file can equal when unreadable. */
function readRawRegistry(registryPath: string): string | null {
  try {
    return readFileSync(registryPath, 'utf-8')
  } catch (error) {
    return isMissingFileError(error) ? null : `\u0000unreadable:${String(error)}`
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
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
