import { randomUUID } from 'node:crypto'
import type { DeviceEntry } from './device-registry'
import { devicePrincipalOf } from './device-principal'

const MAX_FORKS_PER_TOKEN_ROW = 32

export class DeviceKeyForkError extends Error {
  constructor(
    readonly code:
      | 'device_not_found'
      | 'device_already_keyed'
      | 'delegated_device'
      | 'device_key_in_use'
      | 'too_many_device_keys'
  ) {
    super(code)
  }
}

export type DeviceKeyFork = { nextDevices: DeviceEntry[]; entry: DeviceEntry; created: boolean }

/** Fork one installation to a keyed row while retaining other token holders/sockets.
 * Idempotent per token-row/key so lost-reply retries return the same identity. */
export function planDeviceKeyFork(
  devices: readonly DeviceEntry[],
  legacyDeviceId: string,
  devicePublicKeyB64: string,
  label: string,
  now: number,
  options: { ephemeral?: boolean } = {}
): DeviceKeyFork {
  const legacy = devices.find((device) => device.deviceId === legacyDeviceId)
  if (!legacy) {
    throw new DeviceKeyForkError('device_not_found')
  }
  if (legacy.credentialKind === 'device-key' || legacy.token === undefined) {
    throw new DeviceKeyForkError('device_already_keyed')
  }
  // Parent desktops own relayed children's credentials.
  if (legacy.parentDeviceId !== undefined) {
    throw new DeviceKeyForkError('delegated_device')
  }
  const sameKey = devices.filter((device) => device.devicePublicKeyB64 === devicePublicKeyB64)
  const existing = sameKey.find((device) => device.forkedFrom === legacyDeviceId)
  if (existing) {
    return { nextDevices: [...devices], entry: existing, created: false }
  }
  // Reusing a key across rows would merge installation identities.
  if (sameKey.length > 0) {
    throw new DeviceKeyForkError('device_key_in_use')
  }
  // Bound registry growth from a shared pairing code.
  if (
    devices.filter((device) => device.forkedFrom === legacyDeviceId).length >=
    MAX_FORKS_PER_TOKEN_ROW
  ) {
    throw new DeviceKeyForkError('too_many_device_keys')
  }
  const entry: DeviceEntry = {
    deviceId: randomUUID(),
    name: label,
    scope: legacy.scope,
    ...(legacy.grants ? { grants: [...legacy.grants] } : {}),
    pairingReach: legacy.pairingReach,
    ...(legacy.mobilePairingConnectionMode
      ? { mobilePairingConnectionMode: legacy.mobilePairingConnectionMode }
      : {}),
    credentialKind: 'device-key',
    devicePublicKeyB64,
    forkedFrom: legacy.deviceId,
    ...(options.ephemeral ? { ephemeral: true as const } : {}),
    // Preserve orchestration ownership through migration.
    callerFingerprint: devicePrincipalOf(legacy).callerFingerprint,
    pairedAt: now,
    // Zero means pending; rotation would delete the migrated installation.
    lastSeenAt: now
  }
  return { nextDevices: [...devices, entry], entry, created: true }
}
