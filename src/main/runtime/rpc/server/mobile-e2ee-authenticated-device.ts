import type { DeviceRegistry } from './pairing/device-registry'
import { DeviceRegistryUnavailableError } from './pairing/device-registry-unavailable'
import type { MobileSocketTransportMetadata } from '../mobile/mobile-socket-wiring'
import type { DeviceKeyResolution } from '../mobile/e2ee/mobile-e2ee-auth-validation'
import type { DeviceEntry } from './pairing/device-entry'
import { devicePrincipalOf, type DevicePrincipal } from './pairing/device-principal'
import type { AuthorizationIncarnation } from '../../../../shared/authorization-incarnation'

export type E2EEAuthenticatedDevice = DevicePrincipal & {
  // Absent for a keyed row, which never presented a bearer.
  deviceToken?: string
  authority?: AuthorizationIncarnation
}

export function toAuthenticatedDevice(device: DeviceEntry): E2EEAuthenticatedDevice {
  return {
    ...devicePrincipalOf(device),
    ...(device.token !== undefined ? { deviceToken: device.token } : {})
  }
}

export function resolvePairedToken(
  registry: DeviceRegistry,
  token: string,
  metadata: MobileSocketTransportMetadata
): E2EEAuthenticatedDevice | null | { kind: 'unavailable' } {
  try {
    const device = registry.validateToken(token)
    if (!device || (metadata.transport === 'relay' && metadata.relayDeviceId !== device.deviceId)) {
      return null
    }
    return {
      ...toAuthenticatedDevice(device),
      authority:
        registry.captureAuthority({
          deviceId: device.deviceId,
          credentialRevision: device.credentialRevision ?? 0,
          deviceToken: token
        }) ?? undefined
    }
  } catch (error) {
    if (error instanceof DeviceRegistryUnavailableError) {
      return { kind: 'unavailable' }
    }
    throw error
  }
}

export function resolvePairedDeviceKey(
  registry: DeviceRegistry,
  deviceId: string,
  metadata: MobileSocketTransportMetadata
): DeviceKeyResolution<E2EEAuthenticatedDevice> {
  const lookup = registry.lookupDeviceKey(deviceId)
  if (lookup.kind !== 'found') {
    return lookup
  }
  if (
    metadata.transport === 'relay' &&
    metadata.relayDeviceId !== lookup.device.deviceId &&
    metadata.relayDeviceId !== lookup.device.forkedFrom
  ) {
    return { kind: 'refused' }
  }
  return {
    kind: 'found',
    device: {
      ...toAuthenticatedDevice(lookup.device),
      authority:
        registry.captureAuthority({
          deviceId: lookup.device.deviceId,
          credentialRevision: lookup.device.credentialRevision ?? 0
        }) ?? undefined
    },
    devicePublicKeyB64: lookup.device.devicePublicKeyB64
  }
}
