import AsyncStorage from '@react-native-async-storage/async-storage'
import type { UpdateCheckState } from './app-update-check'

// Matches the 'orca:camelCaseKey' convention used across preferences.ts.
const STORAGE_KEY = 'orca:updateCheckState'

export async function loadUpdateCheckState(): Promise<UpdateCheckState> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return {}
    }
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) {
      return {}
    }
    const { lastCheckedAtMs, dismissedVersion } = parsed as UpdateCheckState
    return {
      lastCheckedAtMs: typeof lastCheckedAtMs === 'number' ? lastCheckedAtMs : undefined,
      dismissedVersion: typeof dismissedVersion === 'string' ? dismissedVersion : undefined
    }
  } catch {
    // Why: a corrupt or unreadable record must not block startup; a fresh
    // check is the safe fallback.
    return {}
  }
}

export async function saveUpdateCheckState(state: UpdateCheckState): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // Why: losing the throttle record only costs one extra request next launch.
  }
}
