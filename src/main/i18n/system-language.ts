import { detectUiLanguage, type UiLanguageDetection } from '../../shared/ui-locale'

let snapshot: UiLanguageDetection | null | undefined

export type SystemLanguageReader = {
  isReady(): boolean
  preferredLanguages(): readonly string[]
}

let reader: SystemLanguageReader | null = null

/** Desktop entry binds Electron. Headless runtimes leave this unset. */
export function bindSystemLanguageReader(next: SystemLanguageReader | null): void {
  reader = next
  snapshot = undefined
}

export function getSystemLanguageDetection(
  browserPreferences?: readonly string[]
): UiLanguageDetection | null {
  if (snapshot === undefined) {
    try {
      if (!reader) {
        snapshot = null
      } else if (!reader.isReady()) {
        // Pre-ready startup-failure dialogs still need a language; cache only the post-ready read.
        return readNativeLanguageDetection()
      } else {
        snapshot = readNativeLanguageDetection()
      }
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
  if (!reader) {
    return null
  }
  try {
    const preferences = reader.preferredLanguages()
    return preferences.length ? detectUiLanguage(preferences, 'native') : null
  } catch {
    return null
  }
}
