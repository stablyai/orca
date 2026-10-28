import AsyncStorage from '@react-native-async-storage/async-storage'
import { normalizeHostAppVersion } from './host-app-version'

const STORAGE_KEY_PREFIX = 'orca:host-app-version:v1:'

export async function loadHostAppVersion(hostId: string): Promise<string | null> {
  try {
    return normalizeHostAppVersion(await AsyncStorage.getItem(storageKey(hostId)))
  } catch {
    return null
  }
}

export async function recordHostAppVersion(hostId: string, value: unknown): Promise<void> {
  const appVersion = normalizeHostAppVersion(value)
  if (!appVersion) {
    return
  }
  try {
    const key = storageKey(hostId)
    if (normalizeHostAppVersion(await AsyncStorage.getItem(key)) !== appVersion) {
      await AsyncStorage.setItem(key, appVersion)
    }
  } catch {
    // Best-effort diagnostic metadata must never affect host connectivity.
  }
}

function storageKey(hostId: string): string {
  return `${STORAGE_KEY_PREFIX}${hostId}`
}
