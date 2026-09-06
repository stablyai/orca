import { Platform } from 'react-native'
import { expoIrohModuleLoads } from './expo-iroh-native-module'

/** Presence-based path role for iroh (desktop "Iroh" pairing option). */
export type IrohPathMode = 'off' | 'fallback' | 'primary-off-lan'

const IROH_ENDPOINT_ID = /^[0-9a-f]{64}$/

export function hostHasIrohEndpoint(host: { iroh?: { endpointId?: string } | null }): boolean {
  return typeof host.iroh?.endpointId === 'string' && IROH_ENDPOINT_ID.test(host.iroh.endpointId)
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

// Why: native module is iOS-first; Android methods reject with iroh_android_not_implemented.
export function isIrohNativePlatform(): boolean {
  return Platform.OS === 'ios'
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
