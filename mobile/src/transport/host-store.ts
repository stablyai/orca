import AsyncStorage from '@react-native-async-storage/async-storage'
import * as SecureStore from 'expo-secure-store'
import { Platform } from 'react-native'
import {
  HostProfileSchema,
  StoredHostProfileSchema,
  type HostProfile,
  type StoredHostProfile
} from './types'
import { getNextHostNameFromHosts } from './host-names'
import {
  retryPendingHostCredentialCleanups,
  scheduleHostCredentialCleanup
} from './host-credential-cleanup'

const STORAGE_KEY = 'orca:hosts'
// Why: SecureStore keys must match [A-Za-z0-9._-]; colons are rejected.
// Use dots as the separator so the key shape stays readable while
// satisfying the validator.
const TOKEN_KEY_PREFIX = 'orca.host-token.'
const WEB_TOKEN_KEY_PREFIX = 'orca:web-host-token:'

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

function webTokenKey(hostId: string): string {
  return `${WEB_TOKEN_KEY_PREFIX}${hostId}`
}

async function readDeviceToken(hostId: string): Promise<string | null> {
  // Why: Expo SecureStore has no working web backend; keep this fallback
  // web-only so native builds still keep pairing tokens in the keychain.
  if (Platform.OS === 'web') {
    return AsyncStorage.getItem(webTokenKey(hostId))
  }
  return SecureStore.getItemAsync(tokenKey(hostId), KEYCHAIN_OPTIONS)
}

async function writeDeviceToken(hostId: string, token: string): Promise<void> {
  if (Platform.OS === 'web') {
    await AsyncStorage.setItem(webTokenKey(hostId), token)
    return
  }
  await SecureStore.setItemAsync(tokenKey(hostId), token, KEYCHAIN_OPTIONS)
}

async function deleteDeviceToken(hostId: string): Promise<void> {
  if (Platform.OS === 'web') {
    await AsyncStorage.removeItem(webTokenKey(hostId))
    return
  }
  await SecureStore.deleteItemAsync(tokenKey(hostId), KEYCHAIN_OPTIONS)
}

// Why: SecureStore reads on Android Keystore can take 50-200ms each, and
// loadHosts() is called from every screen mount + every useFocusEffect.
// Stack with N hosts and you get N*200ms blocking every navigation, which
// triggers connection-churn cycles in the home-screen useEffect. Cache
// per-hostId in memory; invalidate only on save/remove. The cache lives
// for the JS-runtime lifetime, which matches AsyncStorage semantics
// (cleared on app uninstall, persisted across foreground/background).
const tokenCache = new Map<string, string>()
let inflightLoad: Promise<HostProfile[]> | null = null
// Why: rename / lastConnected / remove / save all RMW the same hosts JSON.
// Without a queue, concurrent writers re-read a stale snapshot and the last
// setItem wins — resurrecting a removed host or dropping a rename.
let hostListMutation: Promise<void> = Promise.resolve()

function parseStoredHosts(raw: string | null): StoredHostProfile[] | null {
  if (!raw) {
    return []
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) {
      return null
    }
    return parsed.flatMap((item) => {
      // Why: pre-v0.0.3 records carry the deviceToken in AsyncStorage.
      // Drop them silently — the three pre-launch users will re-pair on
      // first run rather than carry a migration shim through the auth path.
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

export async function loadHosts(): Promise<HostProfile[]> {
  // Why: writers hold the mutation chain across their full RMW; wait so a
  // load right after rename/remove does not race a half-written list.
  await hostListMutation
  // Why: deduplicate concurrent loadHosts() calls so multiple screens
  // mounting simultaneously share one Keychain read pass.
  if (inflightLoad) {
    return inflightLoad
  }
  inflightLoad = doLoadHosts().finally(() => {
    inflightLoad = null
  })
  return inflightLoad
}

async function doLoadHosts(): Promise<HostProfile[]> {
  const raw = await AsyncStorage.getItem(STORAGE_KEY)
  const storedHosts = parseStoredHosts(raw)
  if (!storedHosts) {
    return []
  }

  const out: HostProfile[] = []
  for (const stored of storedHosts) {
    let token = tokenCache.get(stored.id)
    if (!token) {
      let fetched: string | null
      try {
        fetched = await readDeviceToken(stored.id)
      } catch {
        // Why: a transient Keychain failure for one entry (e.g.
        // errSecInteractionNotAllowed while the device is briefly locked,
        // or a single corrupt record) must not blank the entire host list.
        // Skip just this host — it'll reappear on the next load.
        continue
      }
      if (!fetched) {
        // Why: orphaned metadata with no matching keychain entry — most
        // likely a stale record from a development install. Skip it
        // rather than surface a half-broken host.
        continue
      }
      token = fetched
      tokenCache.set(stored.id, token)
    }
    out.push({ ...stored, deviceToken: token })
  }
  return out
}

async function loadStoredHosts(): Promise<StoredHostProfile[]> {
  try {
    return parseStoredHosts(await AsyncStorage.getItem(STORAGE_KEY)) ?? []
  } catch {
    return []
  }
}

async function readStoredHostsForMutation(): Promise<StoredHostProfile[]> {
  try {
    const parsed = parseStoredHosts(await AsyncStorage.getItem(STORAGE_KEY))
    if (!parsed) {
      // Why: refuse to RMW over unreadable payload — treating it as [] would
      // wipe the durable host list on the next rename/remove/save.
      throw new Error('host list storage unreadable')
    }
    return parsed
  } catch (error) {
    if (error instanceof Error && error.message === 'host list storage unreadable') {
      throw error
    }
    throw new Error('host list storage unreadable')
  }
}

async function mutateStoredHosts(
  update: (hosts: StoredHostProfile[]) => StoredHostProfile[]
): Promise<void> {
  const mutation = hostListMutation.then(async () => {
    const current = await readStoredHostsForMutation()
    const next = update(current)
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  })
  hostListMutation = mutation.catch(() => {})
  return mutation
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
  const stored = toStored(validated)
  await mutateStoredHosts((hosts) => {
    const index = hosts.findIndex((h) => h.id === stored.id)
    if (index >= 0) {
      const next = hosts.slice()
      next[index] = stored
      return next
    }
    return [...hosts, stored]
  })
  // Why: write metadata BEFORE the keychain token so a crash between the two
  // leaves orphaned metadata (which loadHosts skips and removeHost can clean
  // up) rather than an orphaned keychain token with no metadata pointer —
  // the latter would persist forever since removeHost only deletes by hostId
  // from current metadata.
  await writeDeviceToken(stored.id, validated.deviceToken)
  tokenCache.set(stored.id, validated.deviceToken)
}

export async function removeHost(hostId: string): Promise<void> {
  await mutateStoredHosts((hosts) => hosts.filter((h) => h.id !== hostId))
  tokenCache.delete(hostId)
  // Why: await only the durable cleanup intent (AsyncStorage). Native keychain
  // delete can reject or stall and must not freeze removeHost / the UI.
  try {
    await scheduleHostCredentialCleanup(hostId, deleteDeviceToken)
  } catch {
    // Metadata is already committed; orphan-token recovery is best-effort.
  }
}

export async function retryPendingHostCredentialCleanup(): Promise<{
  clearedCount: number
  remainingIds: string[]
}> {
  return retryPendingHostCredentialCleanups(deleteDeviceToken)
}

export async function renameHost(hostId: string, newName: string): Promise<void> {
  await mutateStoredHosts((hosts) => {
    const index = hosts.findIndex((h) => h.id === hostId)
    if (index < 0) {
      return hosts
    }
    const next = hosts.slice()
    next[index] = { ...next[index]!, name: newName }
    return next
  })
}

export async function getNextHostName(): Promise<string> {
  await hostListMutation
  const hosts = await loadStoredHosts()
  return getNextHostNameFromHosts(hosts)
}

export async function updateLastConnected(hostId: string): Promise<void> {
  await mutateStoredHosts((hosts) => {
    const index = hosts.findIndex((h) => h.id === hostId)
    if (index < 0) {
      return hosts
    }
    const next = hosts.slice()
    next[index] = { ...next[index]!, lastConnected: Date.now() }
    return next
  })
}

/** Test-only: drain module mutation chain between cases. */
export function resetHostStoreForTests(): void {
  hostListMutation = Promise.resolve()
  tokenCache.clear()
  inflightLoad = null
}
