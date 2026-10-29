import { app } from 'electron'
import { detectUiLanguage, type UiLanguageDetection } from '../../shared/ui-locale'

let snapshot: UiLanguageDetection | null | undefined

export function getSystemLanguageDetection(
  browserPreferences?: readonly string[]
): UiLanguageDetection | null {
  if (snapshot === undefined) {
    try {
      if (!app.isReady()) {
        // Pre-ready startup-failure dialogs still need a language; cache only the post-ready read.
        return readNativeLanguageDetection()
      }
      snapshot = readNativeLanguageDetection()
    } catch {
      snapshot = null
    }
  }
  if (snapshot === null && browserPreferences) {
    snapshot = detectUiLanguage(browserPreferences, 'browser-fallback')
  }
  return snapshot
}

function readNativeLanguageDetection(): UiLanguageDetection | null {
  try {
    const preferences = app.getPreferredSystemLanguages()
    return preferences.length ? detectUiLanguage(preferences, 'native') : null
  } catch {
    return null
  }
}
