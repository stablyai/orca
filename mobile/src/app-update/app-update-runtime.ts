import Constants from 'expo-constants'
import { AppState } from 'react-native'
import {
  loadAppUpdatePreferences,
  saveAppUpdateCheck,
  saveDismissedAppUpdateVersion
} from '../storage/app-update-preferences'
import { createAppUpdateChecker } from './app-update-checker'
import { resolveAppUpdateSource } from './resolve-app-update-source'

/**
 * The shell has no expo-updates, so `expoConfig` is the manifest embedded when the binary was
 * built: its version is the binary's (app.json `version`, Android `versionName`), never the page's.
 */
export const installedAppVersion: string | null = Constants.expoConfig?.version ?? null

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
