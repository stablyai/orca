import * as SecureStore from 'expo-secure-store'

export const TRUE_BLACK_STORAGE_KEY = 'orca.appearance.trueBlack'

// SecureStore on web resolves to {} so both functions may be missing; true black is cosmetic and
// must never break app start.
export function readTrueBlackPreference(): boolean {
  try {
    return (
      typeof SecureStore.getItem === 'function' &&
      SecureStore.getItem(TRUE_BLACK_STORAGE_KEY) === 'true'
    )
  } catch {
    return false
  }
}

export function saveTrueBlackPreference(enabled: boolean): void {
  try {
    if (typeof SecureStore.setItem === 'function') {
      SecureStore.setItem(TRUE_BLACK_STORAGE_KEY, enabled ? 'true' : 'false')
    }
  } catch {
    // Ignore storage failures; the setting is cosmetic.
  }
}
