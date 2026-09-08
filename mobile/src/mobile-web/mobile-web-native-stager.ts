import ExpoMobileWebShell from '@orca/expo-mobile-web-shell'
import { MobileWebNativeStagingAdapter } from './mobile-web-native-staging-adapter'

export function createMobileWebNativeStager(hostPublicKey: string): MobileWebNativeStagingAdapter {
  return new MobileWebNativeStagingAdapter(ExpoMobileWebShell, hostPublicKey)
}

export async function removeMobileWebHostCache(hostPublicKey: string): Promise<void> {
  await ExpoMobileWebShell.removeHost(hostPublicKey)
}
