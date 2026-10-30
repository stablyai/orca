import AsyncStorage from '@react-native-async-storage/async-storage'

const KEY = 'orca:liveAlertsPreferences'

export type LiveAlertsPreferences = {
  /** The ongoing live notification and its status-bar chip. */
  enabled: boolean
}

export const DEFAULT_LIVE_ALERTS_PREFERENCES: LiveAlertsPreferences = {
  enabled: true
}

const listeners = new Set<(value: LiveAlertsPreferences) => void>()

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readPreferences(stored: unknown): LiveAlertsPreferences {
  const result = { ...DEFAULT_LIVE_ALERTS_PREFERENCES }
  if (isRecord(stored) && typeof stored.enabled === 'boolean') {
    result.enabled = stored.enabled
  }
  return result
}

export async function loadLiveAlertsPreferences(): Promise<LiveAlertsPreferences> {
  try {
    const raw = await AsyncStorage.getItem(KEY)
    return readPreferences(raw ? JSON.parse(raw) : null)
  } catch {
    return { ...DEFAULT_LIVE_ALERTS_PREFERENCES }
  }
}

/** Saves and tells the running watcher, which applies the change at once. */
export async function saveLiveAlertsPreferences(value: LiveAlertsPreferences): Promise<void> {
  await AsyncStorage.setItem(KEY, JSON.stringify(value))
  for (const listener of listeners) {
    listener({ ...value })
  }
}

export function subscribeLiveAlertsPreferences(
  listener: (value: LiveAlertsPreferences) => void
): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
