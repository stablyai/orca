import AsyncStorage from '@react-native-async-storage/async-storage'
import { StoredHostProfileSchema, type HostProfile, type StoredHostProfile } from './types'

const STORAGE_KEY = 'orca:hosts'

export async function loadStoredHostProfiles(): Promise<StoredHostProfile[] | null> {
  return parseStoredHostProfiles(await AsyncStorage.getItem(STORAGE_KEY))
}

export async function readStoredHostProfilesForMutation(): Promise<StoredHostProfile[]> {
  try {
    const parsed = await loadStoredHostProfiles()
    if (parsed) {
      return parsed
    }
  } catch {
    // Normalize storage and payload failures for fail-closed mutations.
  }
  throw new Error('host list storage unreadable')
}

export function writeStoredHostProfiles(hosts: readonly StoredHostProfile[]): Promise<void> {
  return AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(hosts))
}

export function toStoredHostProfile(host: HostProfile): StoredHostProfile {
  const { id, name, endpoint, publicKeyB64, lastConnected } = host
  return { id, name, endpoint, publicKeyB64, lastConnected }
}

function parseStoredHostProfiles(raw: string | null): StoredHostProfile[] | null {
  if (!raw) {
    return []
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) {
      return null
    }
    return parsed.flatMap((item) => {
      // Why: pre-v0.0.3 records embedded secrets; users re-pair instead of migrating them.
      if (item && typeof item === 'object' && 'deviceToken' in item) {
        return []
      }
      const result = StoredHostProfileSchema.safeParse(item)
      return result.success ? [result.data] : []
    })
  } catch {
    return null
  }
}
