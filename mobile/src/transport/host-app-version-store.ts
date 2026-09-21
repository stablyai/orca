import AsyncStorage from '@react-native-async-storage/async-storage'

const STORAGE_KEY_PREFIX = 'orca:host-app-version:v1:'
const MAX_VERSION_LENGTH = 64

export function normalizeHostAppVersion(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const normalized = value.trim()
  if (
    normalized.length === 0 ||
    normalized.length > MAX_VERSION_LENGTH ||
    normalized.includes('\n') ||
    normalized.includes('\r')
  ) {
    return null
  }
  return normalized
}

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
