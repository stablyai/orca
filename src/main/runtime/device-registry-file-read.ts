import { readFileSync } from 'node:fs'
import { hardenExistingSecureFile, isUnreadableError } from '../../shared/secure-file'
import { corruptRegistryCopyExists, isMissingFileError } from './device-registry-corruption'
import type { DeviceEntry } from './device-entry'
import { normalizeLoadedDeviceRow } from './device-registry-row-validation'

export type DeviceRegistryFileRead = {
  devices: DeviceEntry[]
  /** The registry exists but could not be read, which makes `devices` a lie to save from. */
  unreadable: boolean
  /** A parse failure, now or in an earlier run, means an unlisted device may still exist. */
  doubtful: boolean
  /** A corrupt file must be set aside before the first rewrite. */
  corruptFilePending: boolean
}

export function readDeviceRegistryFile(registryPath: string): DeviceRegistryFileRead {
  // Why: a set-aside corrupt copy keeps revocation verdicts off until the owner removes it, even
  // when the rewrite after quarantine never landed and the registry file itself is missing.
  const doubtful = corruptRegistryCopyExists(registryPath)
  try {
    hardenExistingSecureFile(registryPath)
    const parsed: unknown = JSON.parse(readFileSync(registryPath, 'utf-8'))
    if (!Array.isArray(parsed)) {
      throw new Error('Device registry is not an array')
    }
    const devices = parsed
      .map(normalizeLoadedDeviceRow)
      .filter((device): device is DeviceEntry => device !== null)
    // Why: a dropped row may still be some client's credential; set the file aside like a corrupt one.
    const droppedRows = devices.length !== parsed.length
    return {
      devices,
      unreadable: false,
      doubtful: doubtful || droppedRows,
      corruptFilePending: droppedRows
    }
  } catch (error) {
    if (isMissingFileError(error)) {
      return { devices: [], unreadable: false, doubtful, corruptFilePending: false }
    }
    // "Cannot read" is not "is empty". Saving an empty list over a registry we were merely
    // denied would erase every paired device's bearer token, and the write would succeed.
    const unreadable = isUnreadableError(error)
    // Why: a corrupt file is not evidence any device was revoked; never tell a keyed client so.
    return { devices: [], unreadable, doubtful: true, corruptFilePending: !unreadable }
  }
}
