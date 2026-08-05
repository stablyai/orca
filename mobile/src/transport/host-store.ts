import AsyncStorage from '@react-native-async-storage/async-storage'
import {
  HostProfileSchema,
  StoredHostProfileSchema,
  type HostProfile,
  type StoredHostProfile
} from './types'
import { getNextHostNameFromHosts } from './host-names'
import * as hostListLoads from './host-list-load-sharing'
import { resetPairingKeychainForTests } from './pairing-keychain'
import {
  retryPendingHostCredentialCleanups,
  scheduleHostCredentialCleanup
} from './host-credential-cleanup'
import {
  loadMobileRelayHostOverlayState,
  removeMobileRelayHostOverlay,
  removeMobileRelayHostOverlays,
  saveMobileRelayHostOverlay,
  updateMobileRelayHostOverlayDirectEndpoint
} from './mobile-relay-host-overlay-store'
import { scheduleOrphanedMobileRelayCleanup } from './mobile-relay-orphan-cleanup'
import {
  recordDurableHostIdentity,
  recordHostEndpointMutation,
  recordHostProfileMutation,
  resetHostProfilePublicationForTests,
  retireHostProfilePublication,
  serializeHostProfilePublication
} from './host-profile-publication'
import { readHostDeviceToken, writeHostDeviceToken } from './host-device-token-store'
import { createRemovedHostCredentialDelete, deleteHostCredentials } from './host-credential-delete'

const STORAGE_KEY = 'orca:hosts'
type StoredHostIdentity = Pick<HostProfile, 'endpoint' | 'publicKeyB64'>

// Why: Keychain reads are slow (50-200ms) and loadHosts() runs on every screen mount; cache per-hostId in memory, invalidate on save/remove.
const tokenCache = new Map<string, string>()
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
  return hostListLoads.shareHostListLoad(doLoadHosts)
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
      const readRevision = hostListLoads.getHostListLoadRevision()
      let fetched: string | null
      try {
        fetched = await readHostDeviceToken(stored.id)
      } catch {
        // Why: a transient Keychain failure for one entry (e.g. errSecInteractionNotAllowed while locked) must not blank the whole host list; skip it.
        continue
      }
      if (!fetched) {
        // Why: orphaned metadata with no matching keychain entry; skip rather than surface a half-broken host.
        continue
      }
      token = fetched
      if (readRevision === hostListLoads.getHostListLoadRevision()) {
        tokenCache.set(stored.id, token)
      }
    }
    const overlay = overlays.get(stored.id)
    out.push({
      ...stored,
      deviceToken: token,
      ...(overlay
        ? {
            endpoints: overlay.endpoints.map((endpoint) =>
              endpoint.id === 'direct-primary' && endpoint.kind !== 'relay'
                ? { ...endpoint, url: stored.endpoint }
                : endpoint
            ),
            relayHostId: overlay.relayHostId,
            relay: overlay.relay
          }
        : {})
    })
  }
  return out
}

export async function loadStoredHostIdentity(hostId: string): Promise<StoredHostIdentity | null> {
  await hostListMutation
  const stored = (await readStoredHostsForMutation()).find(({ id }) => id === hostId)
  return stored ? { endpoint: stored.endpoint, publicKeyB64: stored.publicKeyB64 } : null
}

const deleteRemovedHostCredentials = createRemovedHostCredentialDelete(async (hostId) =>
  Boolean(await loadStoredHostIdentity(hostId))
)

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

export async function mutateStoredHosts(
  update: (hosts: StoredHostProfile[]) => StoredHostProfile[],
  beforeWrite?: () => Promise<void>
): Promise<void> {
  const mutation = hostListMutation.then(async () => {
    const current = await readStoredHostsForMutation()
    const next = update(current)
    if (next !== current) {
      await beforeWrite?.()
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next))
      hostListLoads.dropSharedHostListLoad()
    }
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
    return [...hosts.filter(({ id }) => !duplicateHostIds.has(id)), stored]
  })
  // Why: write metadata before the keychain token so a crash leaves recoverable orphaned metadata, not an orphaned token that persists forever.
  await writeHostDeviceToken(stored.id, validated.deviceToken)
  tokenCache.set(stored.id, validated.deviceToken)
  // Why: a later overlay failure must not hide the already-committed credential identity.
  recordDurableHostIdentity(validated)
  hostListLoads.dropSharedHostListLoad()
  if (validated.endpoints) {
    await saveMobileRelayHostOverlay({
      v: 2,
      hostId: stored.id,
      endpoints: validated.endpoints,
      relayHostId: validated.relayHostId,
      relay: validated.relay
    })
    hostListLoads.dropSharedHostListLoad()
  }
  const overlayRemovalIds = [...duplicateHostIds]
  if (!validated.endpoints && updatedExistingHost) {
    overlayRemovalIds.push(stored.id)
  }
  if (overlayRemovalIds.length > 0) {
    // Why: reusing an id for direct-only re-pairing must not retain routing metadata from the previous transport state.
    await removeMobileRelayHostOverlays(overlayRemovalIds)
    hostListLoads.dropSharedHostListLoad()
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
  const retiredPublication = retireHostProfilePublication(hostId)
  await serializeHostProfilePublication(hostId, async () => {
    await mutateStoredHosts((hosts) => hosts.filter((h) => h.id !== hostId))
    tokenCache.delete(hostId)
    try {
      await removeMobileRelayHostOverlay(hostId)
      hostListLoads.dropSharedHostListLoad()
    } catch {
      // Base removal is authoritative; a retained overlay can't resurrect the host and is cleaned on a later retry.
    }
    // Why: keychain delete can stall/reject; await only the durable cleanup intent so removeHost can't freeze the UI.
    try {
      await scheduleHostCredentialCleanup(hostId, deleteRemovedHostCredentials)
    } catch {
      // Metadata is already committed; orphan-token recovery is best-effort.
    }
  })
  if (retiredPublication) {
    // Why: a retired native write may land after the first delete was attempted.
    void retiredPublication.then(() =>
      scheduleHostCredentialCleanup(hostId, deleteRemovedHostCredentials).catch(() => {})
    )
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
  await serializeHostProfilePublication(hostId, async () => {
    await mutateStoredHosts(
      (hosts) => {
        const index = hosts.findIndex((host) => host.id === hostId)
        if (index < 0) {
          throw new Error('Host not found')
        }
        const next = hosts.slice()
        if (updates.name !== undefined) {
          next[index] = { ...next[index]!, name: updates.name }
        }
        if (updates.endpoint !== undefined) {
          next[index] = { ...next[index]!, endpoint: updates.endpoint }
        }
        return next
      },
      updates.endpoint === undefined
        ? undefined
        : () => updateMobileRelayHostOverlayDirectEndpoint(hostId, updates.endpoint!)
    )
    if (updates.endpoint === undefined) {
      recordHostProfileMutation(hostId)
    } else {
      recordHostEndpointMutation(hostId)
    }
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
  hostListLoads.dropSharedHostListLoad()
  resetHostProfilePublicationForTests()
  resetPairingKeychainForTests()
}
