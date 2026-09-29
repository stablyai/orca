import { Platform } from 'react-native'
import { appStoreUpdateSource } from './app-store-update-source'
import type { AppUpdateSource } from './app-update-source'
import { githubReleaseUpdateSource } from './github-release-update-source'

/** The channel that installed this binary; a Play Store source would be picked here. */
export function resolveAppUpdateSource(os: string = Platform.OS): AppUpdateSource | null {
  if (os === 'android') {
    return githubReleaseUpdateSource
  }
  if (os === 'ios') {
    return appStoreUpdateSource
  }
  return null
}
