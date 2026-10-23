import { app } from 'electron'
import { detectUiLanguage, type UiLanguageDetection } from '../../shared/ui-locale'

let snapshot: UiLanguageDetection | null | undefined

export function getSystemLanguageDetection(
  browserPreferences?: readonly string[]
): UiLanguageDetection | null {
  if (snapshot === undefined) {
    try {
      if (!app.isReady()) {
        return null
      }
      const preferences = app.getPreferredSystemLanguages()
      snapshot = preferences.length ? detectUiLanguage(preferences, 'native') : null
    } catch {
      snapshot = null
    }
  }
  if (snapshot === null && browserPreferences) {
    snapshot = detectUiLanguage(browserPreferences, 'browser-fallback')
  }
  return snapshot
}
