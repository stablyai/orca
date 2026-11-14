import AsyncStorage from '@react-native-async-storage/async-storage'
import {
  DICTATION_ENGINE_PREFERENCES,
  type DictationEnginePreference
} from '../mobile-web-shell/bridge/bridge-speech-verbs'

// Where the phone transcribes dictation. Phone-only: the shell answers it to the page with the speech status.
const DICTATION_ENGINE_PREFERENCE_KEY = 'orca:dictationEngine'

export const DEFAULT_DICTATION_ENGINE_PREFERENCE: DictationEnginePreference = 'automatic'

// The shell reads it before every dictation's status and mic start; only this module writes it, so keep it in memory once read.
let cached: DictationEnginePreference | null = null

export async function loadDictationEnginePreference(): Promise<DictationEnginePreference> {
  if (cached !== null) {
    return cached
  }
  try {
    const raw = await AsyncStorage.getItem(DICTATION_ENGINE_PREFERENCE_KEY)
    // A save during the read wins over what the read found.
    cached ??=
      DICTATION_ENGINE_PREFERENCES.find((known) => known === raw) ??
      DEFAULT_DICTATION_ENGINE_PREFERENCE
    return cached
  } catch {
    return DEFAULT_DICTATION_ENGINE_PREFERENCE
  }
}

export async function saveDictationEnginePreference(
  preference: DictationEnginePreference
): Promise<void> {
  cached = preference
  await AsyncStorage.setItem(DICTATION_ENGINE_PREFERENCE_KEY, preference)
}
