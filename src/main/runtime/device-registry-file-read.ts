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
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: normalizeLoadedDeviceRow re-validates every field; a non-array throws below and reads as corrupt.
    const parsed = JSON.parse(readFileSync(registryPath, 'utf-8')) as DeviceEntry[]
    return {
      devices: parsed.map(normalizeLoadedDeviceRow),
      unreadable: false,
      doubtful,
      corruptFilePending: false
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
