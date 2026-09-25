import { requireNativeModule } from 'expo-modules-core'
import { Platform } from 'react-native'

/** Private host API; never expose this module to guest or OTA document scripts. */
export interface BrowserLoopbackNative {
  browserProxyStart(): Promise<{ route: number; port: number }>
  browserProxyAccept(route: number): Promise<number>
  browserProxyRead(route: number, socket: number): Promise<Uint8Array | null>
  browserProxyWrite(route: number, socket: number, bytes: Uint8Array | null): Promise<void>
  browserProxyCloseSocket(route: number, socket: number): void
  browserProxyClose(route: number): void
}

export function getBrowserLoopbackNative(): BrowserLoopbackNative {
  if (Platform.OS !== 'android') {
    throw new Error('Browser loopback adapter requires Android')
  }
  return requireNativeModule<BrowserLoopbackNative>('OrcaMobileWebShell')
}
