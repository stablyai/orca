import type { DeviceEntry } from '../server/pairing/device-entry'
import type { DeviceRegistry } from '../server/pairing/device-registry'
import { devicePrincipalOf } from '../server/pairing/device-principal'
import type { E2EEAuthenticatedDevice } from '../server/mobile-e2ee-authenticated-device'
import type { ObserverCredential } from '../../observer-credential-ledger'
import type { MobileSocketTransportMetadata } from './mobile-socket-wiring'

export function authenticatedDeviceFromEntry(device: DeviceEntry): E2EEAuthenticatedDevice {
  return {
    ...devicePrincipalOf(device),
    ...(device.token !== undefined ? { deviceToken: device.token } : {})
  }
}

export function resolveSocketBearer(
  registry: DeviceRegistry,
  metadata: MobileSocketTransportMetadata,
  token: string,
  observerToken: boolean,
  resolveObserver?: (token: string) => Promise<ObserverCredential | null>
): E2EEAuthenticatedDevice | null | Promise<E2EEAuthenticatedDevice | null> {
  if (observerToken) {
    return metadata.transport === 'direct' && resolveObserver
      ? resolveObserver(token).then((observer) =>
          observer
            ? {
                deviceId: `observer:${observer.id}`,
                clientId: `observer:${observer.id}`,
                scope: 'observer',
                credentialRevision: 0,
                callerFingerprint: observer.tokenHash,
                deviceToken: token,
                observer
              }
            : null
        )
      : null
  }
  const device = registry.validateToken(token)
  if (!device) {
    return null
  }
  // Outer relay authorization cannot choose Orca identity; E2EE resolves the device before readiness.
  if (metadata.transport === 'relay' && metadata.relayDeviceId !== device.deviceId) {
    return null
  }
  return authenticatedDeviceFromEntry(device)
}
