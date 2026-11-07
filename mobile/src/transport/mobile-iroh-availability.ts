import { Platform } from 'react-native'
import { expoIrohModuleLoads } from './expo-iroh-native-module'
import { PAIRING_IROH_ENDPOINT_ID_PATTERN } from '../../../src/shared/remote-runtime/pairing/mobile-pairing-protocol-limits'

/** Presence-based path role for iroh (desktop "Iroh" pairing option). */
export type IrohPathMode = 'off' | 'fallback' | 'primary-off-lan'

/** Enables iroh routing only for a canonical lowercase, 32-byte hexadecimal endpoint ID. */
export function hostHasIrohEndpoint(host: { iroh?: { endpointId?: string } | null }): boolean {
  return (
    typeof host.iroh?.endpointId === 'string' &&
    PAIRING_IROH_ENDPOINT_ID_PATTERN.test(host.iroh.endpointId)
  )
}

/** Iroh offers carry no relay block, so iroh is the sole off-LAN path. */
export function inferIrohPathMode(host: {
  iroh?: { endpointId?: string } | null
  relay?: unknown
}): IrohPathMode {
  if (!hostHasIrohEndpoint(host)) {
    return 'off'
  }
  return host.relay ? 'fallback' : 'primary-off-lan'
}

/** Restricts native iroh attempts to the platforms that ship its bridge implementation. */
export function isIrohNativePlatform(): boolean {
  return Platform.OS === 'ios' || Platform.OS === 'android'
}

/**
 * Sync probe for the native module. Callers use it to fall back to the ws
 * dial BEFORE constructing an iroh socket — a deferred load failure would
 * otherwise surface as an endless iroh reconnect loop (Expo Go, dev client
 * without the pod).
 */
export function isIrohNativeModuleAvailable(): boolean {
  return isIrohNativePlatform() && expoIrohModuleLoads()
}
