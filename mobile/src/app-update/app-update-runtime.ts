import Constants from 'expo-constants'
import * as Linking from 'expo-linking'
import { useSyncExternalStore } from 'react'
import { AppState, Platform } from 'react-native'
import {
  loadAppUpdatePreferences,
  saveAppUpdateCheck,
  saveDismissedAppUpdateVersion
} from '../storage/app-update-preferences'
import { appStoreUpdateSource } from './app-store-update-source'
import { createAppUpdateChecker, type AppUpdateState } from './app-update-checker'
import type { AppUpdateSource } from './app-update-source'
import { githubReleaseUpdateSource } from './github-release-update-source'
import { openAndroidAppUpdate } from './android-update-runtime'

/**
 * Invariant: this app does not use expo-updates, so `expoConfig` is the manifest embedded in the
 * binary and its version is the binary's (app.json `version`, Android `versionName`). SDK 55
 * removed `Constants.nativeAppVersion`; adopting expo-updates would make this the update's version.
 */
export const installedAppVersion: string | null = Constants.expoConfig?.version ?? null

/** The channel that installed this binary. */
function resolveAppUpdateSource(): AppUpdateSource | null {
  if (Platform.OS === 'android') {
    return githubReleaseUpdateSource
  }
  if (Platform.OS === 'ios') {
    return appStoreUpdateSource
  }
  return null
}

export const appUpdateChecker = createAppUpdateChecker({
  source: resolveAppUpdateSource(),
  installedVersion: installedAppVersion,
  now: () => Date.now(),
  setTimer: (run, delayMs) => setTimeout(run, delayMs),
  clearTimer: (handle) => clearTimeout(handle),
  subscribeForeground: (onForeground) => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        onForeground()
      }
    })
    return () => subscription.remove()
  },
  loadPreferences: loadAppUpdatePreferences,
  saveCheck: saveAppUpdateCheck,
  saveDismissedVersion: saveDismissedAppUpdateVersion
})

export function useAppUpdateState(): AppUpdateState {
  return useSyncExternalStore(appUpdateChecker.subscribe, appUpdateChecker.getSnapshot)
}

/** Android downloads in-app when the native updater is present; older shells keep the page fallback. */
export function openAppUpdate(url: string): void {
  if (openAndroidAppUpdate(url)) {
    return
  }
  void Linking.openURL(url).catch(() => {})
}
