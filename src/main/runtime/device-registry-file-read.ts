import { readFileSync } from 'node:fs'
import { hardenExistingSecureFile, isUnreadableError } from '../../shared/secure-file'
import { corruptRegistryCopyExists, isMissingFileError } from './device-registry-corruption'
import type { DeviceEntry } from './device-entry'
import { normalizeLoadedDeviceRow } from './device-registry-row-validation'

export type DeviceRegistryFileRead = {
  devices: DeviceEntry[]
  /** An unreadable registry must never be overwritten from this empty device list. */
  unreadable: boolean
  /** Unlisted devices may still exist after a current or previous parse failure. */
  doubtful: boolean
  /** A corrupt file must be set aside before the first rewrite. */
  corruptFilePending: boolean
}

export function readDeviceRegistryFile(registryPath: string): DeviceRegistryFileRead {
  // Quarantined copies block revocation verdicts until removed, even if no rewrite landed.
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
    // Permission failure is not emptiness; saving here could erase every paired credential.
    const unreadable = isUnreadableError(error)
    // Corruption cannot prove revocation to a keyed client.
    return { devices: [], unreadable, doubtful: true, corruptFilePending: !unreadable }
  }
}
