import { NativeModule, requireOptionalNativeModule } from 'expo-modules-core'
import { AppState, Platform } from 'react-native'
import {
  createAndroidUpdateController,
  type AndroidUpdateDriver,
  type AndroidUpdateProgress
} from './android-update-controller'
import {
  androidUpdateVersion,
  loadAndroidUpdateAsset,
  type AndroidUpdateAsset
} from './android-update-release'

declare class AndroidAppUpdater
  extends NativeModule<{ onProgress(progress: AndroidUpdateProgress): void }>
  implements AndroidUpdateDriver
{
  prepare(asset: AndroidUpdateAsset): Promise<void>
  cancel(): void
  install(): Promise<'permission' | 'installer'>
  canInstall(): boolean
}

const nativeUpdater =
  Platform.OS === 'android'
    ? requireOptionalNativeModule<AndroidAppUpdater>('OrcaAppUpdater')
    : null

export const androidUpdateController = nativeUpdater
  ? createAndroidUpdateController(nativeUpdater, loadAndroidUpdateAsset)
  : null

export function openAndroidAppUpdate(url: string): boolean {
  const version = androidUpdateVersion(url)
  if (!version || !androidUpdateController) {
    return false
  }
  androidUpdateController.open(version, url)
  return true
}

export function startAndroidUpdateForeground(): () => void {
  if (!androidUpdateController) {
    return () => {}
  }
  const subscription = AppState.addEventListener('change', (state) => {
    if (state === 'active') {
      androidUpdateController?.foreground()
    }
  })
  return () => subscription.remove()
}
