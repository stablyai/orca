import Constants from 'expo-constants'
import { getCalendars, getLocales } from 'expo-localization'
import * as Linking from 'expo-linking'
import { useSyncExternalStore } from 'react'
import { AppState, Platform } from 'react-native'
import { OrcaPlayStorePresence } from '../../modules/orca-play-store-presence/src'
import {
  loadAppUpdatePreferences,
  saveAppUpdateCheck,
  saveDismissedAppUpdateVersion
} from '../storage/app-update-preferences'
import { appStoreUpdateSource } from './app-store-update-source'
import { createAppUpdateChecker, type AppUpdateState } from './app-update-checker'
import type { AppUpdateSource } from './app-update-source'
import { isLikelyInMainlandChina, shouldPreferGooglePlay } from './google-play-preference'
import {
  ANDROID_RELEASE_TAG_PREFIX,
  createGithubReleaseUpdateSource,
  RETIRED_ANDROID_RELEASE_TAG_PREFIX
} from './github-release-update-source'

// expoConfig is embedded binary manifest because app does not use expo-updates; SDK 55 removed nativeAppVersion. Revisit version source if adopting OTA updates.
export const installedAppVersion: string | null = Constants.expoConfig?.version ?? null

/** The GitHub APK's package. Orca moved to Google Play as dev.orca.app, so this app gets no more updates. */
export const isRetiredGithubAndroidApp =
  Platform.OS === 'android' && Constants.expoConfig?.android?.package === 'com.stably.orca.mobile'

/** Play delivers this install's updates and forbids other update channels. */
export const isGooglePlayInstall =
  Platform.OS === 'android' && (OrcaPlayStorePresence?.isInstalledByPlayStore() ?? false)

export const GOOGLE_PLAY_URL = 'https://play.google.com/store/apps/details?id=dev.orca.app'

function deviceIsInMainlandChina(): boolean {
  try {
    return isLikelyInMainlandChina({
      regionCodes: getLocales().map((locale) => locale.regionCode),
      timeZone: getCalendars()[0]?.timeZone
    })
  } catch {
    // Unknown region: stay on GitHub, which works everywhere.
    return true
  }
}

/**
 * A GitHub (sideloaded) install outside mainland China is sent to Google Play, which updates it in
 * place because both carry Google's signing key. Mainland China keeps GitHub: Play is unreachable.
 */
export const prefersGooglePlayUpdate = shouldPreferGooglePlay({
  isAndroid: Platform.OS === 'android',
  isRetiredApp: isRetiredGithubAndroidApp,
  isInstalledByPlay: isGooglePlayInstall,
  playStoreUsable: OrcaPlayStorePresence?.isPlayStoreInstalled() ?? false,
  inMainlandChina: deviceIsInMainlandChina()
})

/** The channel that installed this binary. */
function resolveAppUpdateSource(): AppUpdateSource | null {
  if (Platform.OS === 'android') {
    if (isGooglePlayInstall) {
      return null
    }
    return createGithubReleaseUpdateSource(
      (input, init) => fetch(input, init),
      isRetiredGithubAndroidApp ? RETIRED_ANDROID_RELEASE_TAG_PREFIX : ANDROID_RELEASE_TAG_PREFIX
    )
  }
  if (Platform.OS === 'ios') {
    return appStoreUpdateSource
  }
  return null
}

const appUpdateSource = resolveAppUpdateSource()

/** False where no channel can be asked, so there is nothing to check by hand. */
export const canCheckForAppUpdates = appUpdateSource !== null

export const appUpdateChecker = createAppUpdateChecker({
  source: appUpdateSource,
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

/** Opens the update's page: Google Play where it applies, else the GitHub release (Android) or App Store (iOS). */
export function openAppUpdate(url: string): void {
  void Linking.openURL(prefersGooglePlayUpdate ? GOOGLE_PLAY_URL : url).catch(() => {})
}
