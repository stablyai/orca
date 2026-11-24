// Which device a keyed socket signs in as, and whether it still is: a teammate's share device from its
// own store, else a paired device from the registry. Each is held to the Relay binding its outer
// connection was authorized for, and only a whole read may answer unknown (the client erases its key).
import type { DeviceEntry } from '../server/pairing/device-entry'
import type { DeviceRegistry } from '../server/pairing/device-registry'
import type { BotShareDeviceStore } from '../server/pairing/bot-share-device-store'
import { botSharePrincipalOf, devicePrincipalOf } from '../server/pairing/device-principal'
import type { E2EEAuthenticatedDevice } from '../server/mobile-e2ee-authenticated-device'
import type { DeviceKeyResolution } from './e2ee/mobile-e2ee-auth-validation'
import type { MobileSocketTransportMetadata } from './mobile-socket-wiring'

export type SocketDeviceStores = {
  registry: DeviceRegistry
  // Absent, no share device signs in.
  shares: BotShareDeviceStore | undefined
}

export function toAuthenticatedDevice(device: DeviceEntry): E2EEAuthenticatedDevice {
  return {
    ...devicePrincipalOf(device),
    ...(device.token !== undefined ? { deviceToken: device.token } : {})
  }
}

export function resolveSocketDeviceKey(
  stores: SocketDeviceStores,
  deviceId: string,
  metadata: MobileSocketTransportMetadata
): DeviceKeyResolution<E2EEAuthenticatedDevice> {
  const share = stores.shares?.lookupDeviceKey(deviceId) ?? { kind: 'unknown' }
  if (share.kind === 'found') {
    // Outer Relay authorization cannot choose Orca identity, as for a phone.
    return metadata.transport === 'relay' && metadata.relayDeviceId !== share.device.deviceId
      ? { kind: 'refused' }
      : {
          kind: 'found',
          device: botSharePrincipalOf(share.device),
          devicePublicKeyB64: share.device.devicePublicKeyB64
        }
  }
  if (share.kind === 'refused') {
    return share
  }
  const lookup = stores.registry.lookupDeviceKey(deviceId)
  if (lookup.kind === 'unknown' && share.kind === 'unavailable') {
    return share
  }
  if (lookup.kind !== 'found') {
    return lookup
  }
  // Enforce token auth's Relay binding; forks inherit it. Never answer unknown for an existing device or the client deletes its key.
  if (
    metadata.transport === 'relay' &&
    metadata.relayDeviceId !== lookup.device.deviceId &&
    metadata.relayDeviceId !== lookup.device.forkedFrom
  ) {
    return { kind: 'refused' }
  }
  return {
    kind: 'found',
    device: toAuthenticatedDevice(lookup.device),
    devicePublicKeyB64: lookup.device.devicePublicKeyB64
  }
}

/** A share device is checked only against its own store, a paired one only against the registry. */
export function socketStillAuthenticated(
  stores: SocketDeviceStores,
  device: E2EEAuthenticatedDevice
): boolean {
  const current = device.botShare
    ? stores.shares?.resolveAuthenticatedPrincipal(device.deviceId, device.botShare)
    : stores.registry.resolveAuthenticatedPrincipal(device)
  return current !== null && current !== undefined
}
