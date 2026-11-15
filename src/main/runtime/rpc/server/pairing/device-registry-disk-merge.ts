import { readFileSync, statSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import {
  writeDurableSecureJsonFile,
  writeSecureJsonFile
} from '../../../../../shared/secure-storage/secure-file'
import type { DeviceEntry } from './device-entry'
import { isMissingFileError, quarantineCorruptRegistry } from './device-registry-corruption'
import { readDeviceRegistryFile, type DeviceRegistryFileRead } from './device-registry-file-read'
import { reconcileDeviceRegistry } from './device-registry-reconciliation'
import { DeviceRegistryUnavailableError } from './device-registry-unavailable'

const EXTERNAL_EDIT_CHECK_INTERVAL_MS = 1000
const MAX_WRITE_ATTEMPTS = 5
export type DeviceRegistrySaveOptions = { durable?: boolean; guards?: readonly string[] }

export class DeviceRegistryWriter {
  private readonly removedIds = new Set<string>()
  private baseline: DeviceEntry[] = []
  private quarantinedUntilWritten = false
  private readStamp: string | null = null
  private checkedAt = Number.NEGATIVE_INFINITY
  unavailable = false
  doubtful = false
  private operation: { remaining: number; failure?: DeviceRegistryUnavailableError } | null = null

  constructor(private readonly registryPath: string) {}

  /** Nested synchronous credential changes share one publication budget and final failure. */
  runOperation<T>(action: () => T): T {
    if (this.operation) {
      return action()
    }
    this.operation = { remaining: MAX_WRITE_ATTEMPTS }
    try {
      return action()
    } finally {
      this.operation = null
    }
  }

  retireRows(ids: readonly string[]): void {
    for (const id of ids) {
      this.removedIds.add(id)
    }
  }

  needsFirstSightingSave(id: string): boolean {
    return this.baseline.some((row) => row.deviceId === id && row.lastSeenAt === 0)
  }

  quarantineCorrupt(): void {
    if (quarantineCorruptRegistry(this.registryPath)) {
      this.quarantinedUntilWritten = true
      this.baseline = []
      this.readStamp = null
    }
  }

  read(): DeviceRegistryFileRead {
    const stamp = fileStamp(this.registryPath)
    const disk = readDeviceRegistryFile(this.registryPath)
    this.unavailable = disk.unreadable || disk.corruptFilePending
    this.doubtful = disk.doubtful
    if (!this.unavailable) {
      this.baseline = disk.devices
      this.readStamp = stamp
    }
    return disk
  }

  adoptExternalEdits(
    current: readonly DeviceEntry[],
    options: { fresh?: boolean } = {}
  ): DeviceEntry[] | null {
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
    const baseline = this.baseline
    const disk = this.read()
    if (this.unavailable) {
      return null
    }
    if (this.quarantinedUntilWritten) {
      return reconcileDeviceRegistry([], current, disk.devices, this.removedIds).devices
    }
    return reconcileDeviceRegistry(baseline, current, disk.devices, this.removedIds, {
      observing: true
    }).devices
  }

  write(
    before: readonly DeviceEntry[],
    next: readonly DeviceEntry[],
    options: DeviceRegistrySaveOptions = {}
  ): DeviceEntry[] {
    return this.runOperation(() => this.writeWithinOperation(before, next, options))
  }

  private writeWithinOperation(
    before: readonly DeviceEntry[],
    next: readonly DeviceEntry[],
    options: DeviceRegistrySaveOptions
  ): DeviceEntry[] {
    const operation = this.operation!
    if (operation.failure) {
      throw operation.failure
    }
    const baseline = this.quarantinedUntilWritten ? [] : this.baseline
    const existing = new Set(before.map((row) => row.deviceId))
    const created = new Set(
      next.filter((row) => !existing.has(row.deviceId)).map((row) => row.deviceId)
    )
    let observed: DeviceEntry[] | null = null
    const winner = () =>
      observed === null
        ? null
        : reconcileDeviceRegistry(baseline, before, observed, this.removedIds, {
            observing: !this.quarantinedUntilWritten
          }).devices
    this.readStamp = null
    const observe = (disk: DeviceRegistryFileRead): boolean => {
      this.unavailable = disk.unreadable || disk.corruptFilePending
      this.doubtful = disk.doubtful
      if (this.unavailable) {
        return false
      }
      this.baseline = disk.devices
      observed = disk.devices
      return true
    }
    const fail = (reason: DeviceRegistryUnavailableError['reason'], cause?: unknown): never => {
      observe(readDeviceRegistryFile(this.registryPath))
      this.readStamp = null
      const error = new DeviceRegistryUnavailableError(reason, winner(), cause)
      operation.failure = error
      throw error
    }
    while (operation.remaining > 0) {
      operation.remaining--
      const raw = readRawRegistry(this.registryPath)
      const disk = readDeviceRegistryFile(this.registryPath)
      if (raw !== readRawRegistry(this.registryPath)) {
        continue
      }
      if (!observe(disk)) {
        continue
      }
      const merged = reconcileDeviceRegistry(baseline, next, disk.devices, this.removedIds, {
        guards: options.guards,
        created: this.quarantinedUntilWritten ? undefined : created
      })
      if (merged.conflict) {
        throw new DeviceRegistryUnavailableError('conflict', winner())
      }
      let published = false
      try {
        if (isDeepStrictEqual(merged.devices, disk.devices)) {
          published = true
        } else {
          const write = options.durable ? writeDurableSecureJsonFile : writeSecureJsonFile
          write(this.registryPath, merged.devices, {
            // A pre-rename comparison narrows races; it is not an atomic cross-process CAS.
            shouldPublish: () => (published = readRawRegistry(this.registryPath) === raw)
          })
        }
      } catch (error) {
        return fail('io', error)
      }
      if (published) {
        const remaining = new Set(next.map((row) => row.deviceId))
        this.retireRows(
          before.filter((row) => !remaining.has(row.deviceId)).map((row) => row.deviceId)
        )
        this.baseline = merged.devices
        this.quarantinedUntilWritten = false
        this.unavailable = false
        this.readStamp = null
        return merged.devices
      }
    }
    return fail(this.unavailable ? 'snapshot' : 'contended')
  }
}

function readRawRegistry(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    return isMissingFileError(error) ? null : `unreadable:${String(error)}`
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
