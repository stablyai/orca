import Constants from 'expo-constants'
import { Platform } from 'react-native'
import { isLocalRuntimeAvailable } from '../../modules/orca-local-runtime/src'

/** True only in the sideloaded standalone Android flavor on an arm64 device. */
export function canRunLocalHost(): boolean {
  if (Platform.OS !== 'android') {
    return false
  }
  return Constants.expoConfig?.extra?.orcaAndroidStandalone === true && isLocalRuntimeAvailable()
}

/** Where a developer `adb push`es a locally built orcad bundle; readable without storage permission. */
export function defaultDevOrcadBundleUrl(): string {
  const applicationId = Constants.expoConfig?.android?.package ?? 'com.stably.orca.standalone'
  return `file:///sdcard/Android/data/${applicationId}/files/orcad.tar.gz`
}
