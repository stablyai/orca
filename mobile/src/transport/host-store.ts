import AsyncStorage from '@react-native-async-storage/async-storage'
import * as SecureStore from 'expo-secure-store'
import {
  HostProfileSchema,
  StoredHostProfileSchema,
  type HostProfile,
  type StoredHostProfile
} from './types'

const STORAGE_KEY = 'orca:hosts'
// Why: SecureStore keys must match [A-Za-z0-9._-]; colons are rejected.
// Use dots as the separator so the key shape stays readable while
// satisfying the validator.
const TOKEN_KEY_PREFIX = 'orca.host-token.'

// Why: WHEN_UNLOCKED_THIS_DEVICE_ONLY keeps the pairing token off
// iCloud Keychain and out of iCloud/iTunes backup restores onto a
// different physical device. Reads/writes are silent (no biometric
// prompt) since we don't request access control flags.
const KEYCHAIN_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY
}

function tokenKey(hostId: string): string {
  return `${TOKEN_KEY_PREFIX}${hostId}`
}

export async function loadHosts(): Promise<HostProfile[]> {
  const raw = await AsyncStorage.getItem(STORAGE_KEY)
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []

  const out: HostProfile[] = []
  for (const item of parsed) {
    // Why: pre-v0.0.3 records carry the deviceToken in AsyncStorage.
    // Drop them silently — the three pre-launch users will re-pair on
    // first run rather than carry a migration shim through the auth
    // path.
    if (item && typeof item === 'object' && 'deviceToken' in item) {
      continue
    }
    const stored = StoredHostProfileSchema.safeParse(item)
    if (!stored.success) continue

    const token = await SecureStore.getItemAsync(tokenKey(stored.data.id), KEYCHAIN_OPTIONS)
    if (!token) {
      // Why: orphaned metadata with no matching keychain entry — most
      // likely a stale record from a development install. Skip it
      // rather than surface a half-broken host.
      continue
    }
    out.push({ ...stored.data, deviceToken: token })
  }
  return out
}

async function loadStoredHosts(): Promise<StoredHostProfile[]> {
  const raw = await AsyncStorage.getItem(STORAGE_KEY)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((item) => {
      // Why: same drop-old-records rule as loadHosts; keeps internal
      // mutators from re-persisting pre-v0.0.3 entries.
      if (item && typeof item === 'object' && 'deviceToken' in item) return []
      const result = StoredHostProfileSchema.safeParse(item)
      return result.success ? [result.data] : []
    })
  } catch {
    return []
  }
}

function toStored(host: HostProfile): StoredHostProfile {
  return {
    id: host.id,
    name: host.name,
    endpoint: host.endpoint,
    publicKeyB64: host.publicKeyB64,
    lastConnected: host.lastConnected
  }
}

export async function saveHost(host: HostProfile): Promise<void> {
  const validated = HostProfileSchema.parse(host)
  const hosts = await loadStoredHosts()
  const stored = toStored(validated)
  const index = hosts.findIndex((h) => h.id === stored.id)
  if (index >= 0) {
    hosts[index] = stored
  } else {
    hosts.push(stored)
  }
  await SecureStore.setItemAsync(tokenKey(stored.id), validated.deviceToken, KEYCHAIN_OPTIONS)
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(hosts))
}

export async function removeHost(hostId: string): Promise<void> {
  const hosts = await loadStoredHosts()
  const filtered = hosts.filter((h) => h.id !== hostId)
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(filtered))
  await SecureStore.deleteItemAsync(tokenKey(hostId), KEYCHAIN_OPTIONS)
}

export async function renameHost(hostId: string, newName: string): Promise<void> {
  const hosts = await loadStoredHosts()
  const host = hosts.find((h) => h.id === hostId)
  if (host) {
    host.name = newName
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(hosts))
  }
}

export async function getNextHostName(): Promise<string> {
  const hosts = await loadStoredHosts()
  const existingNumbers = hosts
    .map((h) => {
      const match = h.name.match(/^Host (\d+)$/)
      return match ? parseInt(match[1]!, 10) : 0
    })
    .filter((n) => n > 0)
  const next = existingNumbers.length > 0 ? Math.max(...existingNumbers) + 1 : 1
  return `Host ${next}`
}

export async function updateLastConnected(hostId: string): Promise<void> {
  const hosts = await loadStoredHosts()
  const host = hosts.find((h) => h.id === hostId)
  if (host) {
    host.lastConnected = Date.now()
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(hosts))
  }
}
