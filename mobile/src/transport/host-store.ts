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
import {
  loadMobileRelayHostOverlayState,
  removeMobileRelayHostOverlay,
  removeMobileRelayHostOverlays,
  saveMobileRelayHostOverlay
} from './mobile-relay-host-overlay-store'
import { deleteMobileRelayCredentialBundle } from './mobile-relay-credential-bundle'
import { deleteMobileRelayDirectUpgradeJournal } from './mobile-relay-direct-upgrade-journal'
import { scheduleOrphanedMobileRelayCleanup } from './mobile-relay-orphan-cleanup'

const STORAGE_KEY = 'orca:hosts'
// Why: SecureStore keys must match [A-Za-z0-9._-] (colons rejected), so use dots as the separator.
const TOKEN_KEY_PREFIX = 'orca.host-token.'
const WEB_TOKEN_KEY_PREFIX = 'orca:web-host-token:'

// Why: WHEN_UNLOCKED_THIS_DEVICE_ONLY keeps the pairing token off iCloud Keychain and out of backup restores onto another device.
// Reads/writes stay silent (no biometric prompt) because we don't request access control flags.
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
  // Why: Expo SecureStore has no working web backend; fall back to AsyncStorage only on web so native still uses the keychain.
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

async function deleteHostCredentials(hostId: string): Promise<void> {
  await deleteDeviceToken(hostId)
  await deleteMobileRelayCredentialBundle(hostId)
  await deleteMobileRelayDirectUpgradeJournal(hostId)
}

// Why: Keychain reads are slow (50-200ms) and loadHosts() runs on every screen mount; cache per-hostId in memory, invalidate on save/remove.
const tokenCache = new Map<string, string>()
let inflightLoad: Promise<HostProfile[]> | null = null
// Why: serialize RMW of the shared hosts JSON; without a queue concurrent writers drop writes (resurrect a removed host, drop a rename).
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
      // Why: pre-v0.0.3 records stored deviceToken in AsyncStorage; drop them (users re-pair) rather than carry a migration shim.
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
  // Why: writers hold the mutation chain across their full RMW; wait so a load doesn't race a half-written list.
  await hostListMutation
  // Why: deduplicate concurrent loadHosts() calls so simultaneously mounting screens share one Keychain read pass.
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
  const overlayState = await loadMobileRelayHostOverlayState(
    new Set(storedHosts.map(({ id }) => id))
  )
  await scheduleOrphanedMobileRelayCleanup({
    hostIds: overlayState.orphanHostIds,
    deleteCredential: deleteHostCredentials
  })
  const overlays = overlayState.overlays

  const out: HostProfile[] = []
  for (const stored of storedHosts) {
    let token = tokenCache.get(stored.id)
    if (!token) {
      let fetched: string | null
      try {
        fetched = await readDeviceToken(stored.id)
      } catch {
        // Why: a transient Keychain failure for one entry (e.g. errSecInteractionNotAllowed while locked) must not blank the whole host list; skip it.
        continue
      }
      if (!fetched) {
        // Why: orphaned metadata with no matching keychain entry; skip rather than surface a half-broken host.
        continue
      }
      token = fetched
      tokenCache.set(stored.id, token)
    }
    const overlay = overlays.get(stored.id)
    out.push({
      ...stored,
      deviceToken: token,
      ...(overlay
        ? {
            endpoints: overlay.endpoints,
            relayHostId: overlay.relayHostId,
            relay: overlay.relay
          }
        : {})
    })
  }
  return out
}

export async function resolvePairingHostIdentity(
  publicKeyB64: string,
  newHostId: string
): Promise<{ id: string; name: string }> {
  // Why: one durable read both preserves an existing identity and names a new host, avoiding duplicate cards.
  await hostListMutation
  const hosts = await readStoredHostsForMutation()
  const match = hosts.find((host) => host.publicKeyB64 === publicKeyB64)
  return match
    ? { id: match.id, name: match.name }
    : { id: newHostId, name: getNextHostNameFromHosts(hosts) }
}

async function readStoredHostsForMutation(): Promise<StoredHostProfile[]> {
  try {
    const parsed = parseStoredHosts(await AsyncStorage.getItem(STORAGE_KEY))
    if (!parsed) {
      // Why: refuse to RMW over unreadable payload — treating it as [] would wipe the durable host list on the next write.
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

export class MobileRelayUpgradeHostRemovedError extends Error {}

export async function saveHost(host: HostProfile): Promise<void> {
  await persistHost(host, false)
}

export async function saveExistingHostRelayUpgrade(host: HostProfile): Promise<void> {
  await persistHost(host, true)
}

async function persistHost(host: HostProfile, requireExisting: boolean): Promise<void> {
  const validated = HostProfileSchema.parse(host)
  const stored = toStored(validated)
  const duplicateHostIds = new Set<string>()
  let updatedExistingHost = false
  await mutateStoredHosts((hosts) => {
    const index = hosts.findIndex((h) => h.id === stored.id)
    for (const candidate of hosts) {
      if (candidate.id !== stored.id && candidate.publicKeyB64 === stored.publicKeyB64) {
        duplicateHostIds.add(candidate.id)
      }
    }
    if (index >= 0) {
      updatedExistingHost = true
      // Why: an authoritative save is the safe point to collapse pre-existing duplicate rows to the preserved host id.
      return hosts
        .filter(({ id }) => !duplicateHostIds.has(id))
        .map((candidate) => (candidate.id === stored.id ? stored : candidate))
    }
    if (requireExisting) {
      // Why: an in-flight relay upgrade must not resurrect a host the user removed.
      throw new MobileRelayUpgradeHostRemovedError('mobile relay upgrade host was removed')
    }
    return [...hosts.filter(({ id }) => !duplicateHostIds.has(id)), stored]
  })
  // Why: write metadata before the keychain token so a crash leaves recoverable orphaned metadata, not an orphaned token that persists forever.
  await writeDeviceToken(stored.id, validated.deviceToken)
  tokenCache.set(stored.id, validated.deviceToken)
  if (validated.endpoints) {
    await saveMobileRelayHostOverlay({
      v: 2,
      hostId: stored.id,
      endpoints: validated.endpoints,
      relayHostId: validated.relayHostId,
      relay: validated.relay
    })
  }
  const overlayRemovalIds = [...duplicateHostIds]
  if (!validated.endpoints && updatedExistingHost) {
    overlayRemovalIds.push(stored.id)
  }
  if (overlayRemovalIds.length > 0) {
    // Why: reusing an id for direct-only re-pairing must not retain routing metadata from the previous transport state.
    await removeMobileRelayHostOverlays(overlayRemovalIds)
  }
  for (const duplicateHostId of duplicateHostIds) {
    tokenCache.delete(duplicateHostId)
    try {
      await scheduleHostCredentialCleanup(duplicateHostId, deleteHostCredentials)
    } catch {
      // Metadata is already deduplicated; orphan-token recovery is best-effort.
    }
  }
}

export async function removeHost(hostId: string): Promise<void> {
  await mutateStoredHosts((hosts) => hosts.filter((h) => h.id !== hostId))
  tokenCache.delete(hostId)
  try {
    await removeMobileRelayHostOverlay(hostId)
  } catch {
    // Base removal is authoritative; a retained overlay can't resurrect the host and is cleaned on a later retry.
  }
  // Why: keychain delete can stall/reject; await only the durable cleanup intent so removeHost can't freeze the UI.
  try {
    await scheduleHostCredentialCleanup(hostId, deleteHostCredentials)
  } catch {
    // Metadata is already committed; orphan-token recovery is best-effort.
  }
}

export async function retryPendingHostCredentialCleanup(): Promise<{
  clearedCount: number
  remainingIds: string[]
  storageUnreadable: boolean
}> {
  return retryPendingHostCredentialCleanups(deleteHostCredentials)
}

// Why: single mutation pass commits name + endpoint atomically so a mid-save failure can't persist one without the other.
export async function updateHostNameAndEndpoint(
  hostId: string,
  updates: { name?: string; endpoint?: string }
): Promise<void> {
  await mutateStoredHosts((hosts) => {
    const index = hosts.findIndex((host) => host.id === hostId)
    if (index < 0) {
      throw new Error('Host not found')
    }
    const next = hosts.slice()
    next[index] = {
      ...next[index]!,
      ...(updates.name !== undefined ? { name: updates.name } : {}),
      ...(updates.endpoint !== undefined ? { endpoint: updates.endpoint } : {})
    }
    return next
  })
}

export async function updateLastConnected(hostId: string): Promise<void> {
  try {
    await mutateStoredHosts((hosts) => {
      const index = hosts.findIndex((h) => h.id === hostId)
      if (index < 0) {
        return hosts
      }
      const next = hosts.slice()
      next[index] = { ...next[index]!, lastConnected: Date.now() }
      return next
    })
  } catch {
    // Why: best-effort timestamp fired with void; swallow so unreadable storage doesn't reject.
  }
}

/** Test-only: drain module mutation chain between cases. */
export function resetHostStoreForTests(): void {
  hostListMutation = Promise.resolve()
  tokenCache.clear()
  inflightLoad = null
}
