import { HostProfileSchema } from './types'
import type { HostCatalogEntry, HostProfile, StoredHostProfile } from './types'
import { getNextHostNameFromHosts } from './host-names'
import * as hostListLoads from './host-list-load-sharing'
import { joinHostCatalogCredentials } from './host-catalog-credential-join'
import { resetPairingKeychainForTests } from './pairing-keychain'
import { readHostDeviceToken, writeHostDeviceToken } from './host-device-token-store'
import {
  cancelPendingHostCredentialCleanup,
  recordHostCredentialCleanupIntent,
  retryPendingHostCredentialCleanups,
  scheduleHostCredentialCleanup
} from './host-credential-cleanup'
import {
  loadMobileRelayHostOverlayState,
  removeMobileRelayHostOverlay,
  removeMobileRelayHostOverlays,
  saveMobileRelayHostOverlay
} from './mobile-relay-host-overlay-store'
import { scheduleOrphanedMobileRelayCleanup } from './mobile-relay-orphan-cleanup'
import {
  getHostCredentialWriteRevision,
  markHostCredentialWrite,
  resetHostCredentialWriteRevisionsForTests
} from './host-credential-write-revision'
import { createUnpairedHostCredentialDeletion } from './unpaired-host-credential-deletion'
import {
  loadStoredHostProfiles,
  readStoredHostProfilesForMutation,
  toStoredHostProfile,
  writeStoredHostProfiles
} from './host-metadata-store'

async function commitDeviceToken(hostId: string, token: string): Promise<void> {
  markHostCredentialWrite(hostId)
  await writeHostDeviceToken(hostId, token)
  tokenCache.set(hostId, token)
  hostListLoads.dropSharedHostListLoad()
}

// Why: Keychain reads are slow (50-200ms) and loadHosts() runs on every screen mount; cache per-hostId in memory, invalidate on save/remove.
const tokenCache = new Map<string, string>()
// Why: serialize host metadata RMW so concurrent writers cannot drop updates.
let hostListMutation: Promise<void> = Promise.resolve()

export const loadHosts = async (): Promise<HostProfile[]> => (await loadHostListSnapshot()).profiles
export const loadHostCatalog = async (): Promise<HostCatalogEntry[]> =>
  (await loadHostListSnapshot()).catalog

async function loadHostListSnapshot(): Promise<hostListLoads.HostListSnapshot> {
  // Why: writers hold the mutation chain across their full RMW; wait so a load doesn't race a half-written list.
  await hostListMutation
  // Why: deduplicate concurrent loadHosts() calls so simultaneously mounting screens share one Keychain read pass.
  return hostListLoads.shareHostListLoad(doLoadHostListSnapshot)
}

async function doLoadHostListSnapshot(): Promise<hostListLoads.HostListSnapshot> {
  const storedHosts = await loadStoredHostProfiles()
  if (!storedHosts) {
    return { catalog: [], profiles: [] }
  }
  const overlayState = await loadMobileRelayHostOverlayState(
    new Set(storedHosts.map(({ id }) => id))
  )
  const orphanWriteRevisions = new Map(
    overlayState.orphanHostIds.map((hostId) => [hostId, getHostCredentialWriteRevision(hostId)])
  )
  await scheduleOrphanedMobileRelayCleanup({
    hostIds: overlayState.orphanHostIds,
    deleteCredential: (hostId) =>
      deleteUnpairedHostCredentials(hostId, orphanWriteRevisions.get(hostId) ?? 0),
    removeOverlay: removeOrphanOverlayIfUnpaired
  })
  return joinHostCatalogCredentials({
    storedHosts,
    overlays: overlayState.overlays,
    tokenCache,
    readToken: readHostDeviceToken,
    getRevision: hostListLoads.getHostListLoadRevision
  })
}

export async function resolvePairingHostIdentity(
  publicKeyB64: string,
  newHostId: string
): Promise<{ id: string; name: string }> {
  // Why: one durable read both preserves an existing identity and names a new host, avoiding duplicate cards.
  await hostListMutation
  const hosts = await readStoredHostProfilesForMutation()
  const match = hosts.find((host) => host.publicKeyB64 === publicKeyB64)
  return match
    ? { id: match.id, name: match.name }
    : { id: newHostId, name: getNextHostNameFromHosts(hosts) }
}

const deleteUnpairedHostCredentials = createUnpairedHostCredentialDeletion({
  waitForHostMutations: () => hostListMutation,
  hasStoredHost: async (hostId) =>
    (await readStoredHostProfilesForMutation()).some(({ id }) => id === hostId),
  onDeleted: (hostId) => {
    tokenCache.delete(hostId)
    hostListLoads.dropSharedHostListLoad()
  }
})

function scheduleUnpairedHostCredentialCleanup(hostId: string): Promise<void> {
  const writeRevision = getHostCredentialWriteRevision(hostId)
  return scheduleHostCredentialCleanup(hostId, (id) =>
    deleteUnpairedHostCredentials(id, writeRevision)
  )
}

function cancelCleanupForStoredHost(hostId: string): void {
  const cancellation = hostListMutation.then(async () => {
    const hosts = await readStoredHostProfilesForMutation()
    if (hosts.some(({ id }) => id === hostId)) {
      // Register before later removals enqueue their intent, without blocking host loads on cleanup storage.
      void cancelPendingHostCredentialCleanup(hostId).catch(() => undefined)
    }
  })
  hostListMutation = cancellation.catch(() => {})
}

async function cancelCleanupForDurablyStoredHosts(hostIds: Iterable<string>): Promise<void> {
  const targets = [...hostIds]
  return enqueueHostListMutation(async () => {
    const storedIds = new Set((await readStoredHostProfilesForMutation()).map(({ id }) => id))
    await Promise.all(
      targets
        .filter((hostId) => storedIds.has(hostId))
        .map((hostId) => cancelPendingHostCredentialCleanup(hostId).catch(() => undefined))
    )
  }).catch(() => undefined)
}

function enqueueHostListMutation(operation: () => Promise<void>): Promise<void> {
  const mutation = hostListMutation.then(operation)
  hostListMutation = mutation.catch(() => {})
  return mutation
}

function removeOrphanOverlayIfUnpaired(hostId: string): Promise<void> {
  return enqueueHostListMutation(async () => {
    const hosts = await readStoredHostProfilesForMutation()
    if (!hosts.some(({ id }) => id === hostId)) {
      await removeMobileRelayHostOverlay(hostId)
    }
  })
}

async function mutateStoredHosts(
  update: (hosts: StoredHostProfile[]) => StoredHostProfile[] | Promise<StoredHostProfile[]>
): Promise<void> {
  return enqueueHostListMutation(async () => {
    const current = await readStoredHostProfilesForMutation()
    const next = await update(current)
    await writeStoredHostProfiles(next)
    hostListLoads.dropSharedHostListLoad()
  })
}

export class MobileRelayUpgradeHostRemovedError extends Error {}

export const saveHost = (host: HostProfile): Promise<void> => persistHost(host, false)

export const saveExistingHostRelayUpgrade = (host: HostProfile): Promise<void> =>
  persistHost(host, true)

async function persistHost(host: HostProfile, requireExisting: boolean): Promise<void> {
  const validated = HostProfileSchema.parse(host)
  const stored = toStoredHostProfile(validated)
  const duplicateHostIds = new Set<string>()
  let updatedExistingHost = false
  let cleanupIntentRecordedBeforeMetadata = false
  let tokenCommittedBeforeMetadata = false
  try {
    await mutateStoredHosts(async (hosts) => {
      const index = hosts.findIndex((h) => h.id === stored.id)
      for (const candidate of hosts) {
        if (candidate.id !== stored.id && candidate.publicKeyB64 === stored.publicKeyB64) {
          duplicateHostIds.add(candidate.id)
        }
      }
      let next: StoredHostProfile[]
      if (index >= 0) {
        updatedExistingHost = true
        // Why: an authoritative save is the safe point to collapse pre-existing duplicate rows to the preserved host id.
        next = hosts
          .filter(({ id }) => !duplicateHostIds.has(id))
          .map((candidate) => (candidate.id === stored.id ? stored : candidate))
      } else if (requireExisting) {
        // Why: an in-flight relay upgrade must not resurrect a host the user removed.
        throw new MobileRelayUpgradeHostRemovedError('mobile relay upgrade host was removed')
      } else {
        next = [...hosts.filter(({ id }) => !duplicateHostIds.has(id)), stored]
      }
      if (duplicateHostIds.size > 0) {
        if (index < 0) {
          // Why: process death between the early token write and metadata publication must leave cleanup discoverable.
          await recordHostCredentialCleanupIntent(stored.id)
          cleanupIntentRecordedBeforeMetadata = true
        }
        for (const duplicateHostId of duplicateHostIds) {
          await recordHostCredentialCleanupIntent(duplicateHostId)
        }
        // Why: never remove the only usable same-key row until its replacement credential is durable.
        await commitDeviceToken(stored.id, validated.deviceToken)
        tokenCommittedBeforeMetadata = true
      }
      return next
    })
  } catch (error) {
    await cancelCleanupForDurablyStoredHosts(duplicateHostIds)
    if (cleanupIntentRecordedBeforeMetadata) {
      try {
        await scheduleUnpairedHostCredentialCleanup(stored.id)
      } catch {
        // The write-ahead cleanup intent remains available for retry.
      }
    }
    throw error
  }
  if (!tokenCommittedBeforeMetadata) {
    // Why: the catalog can now surface a failed token write for recovery instead of losing the host.
    await commitDeviceToken(stored.id, validated.deviceToken)
  }
  // Why: a later removal owns its cleanup intent; cancel only while this publication remains authoritative.
  cancelCleanupForStoredHost(stored.id)
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
    try {
      await scheduleUnpairedHostCredentialCleanup(duplicateHostId)
    } catch {
      // Metadata is already deduplicated; orphan-token recovery is best-effort.
    }
  }
}

export async function removeHost(hostId: string): Promise<void> {
  let cleanupIntentRecorded = false
  try {
    await mutateStoredHosts(async (hosts) => {
      try {
        await recordHostCredentialCleanupIntent(hostId)
        cleanupIntentRecorded = true
      } catch {
        // Removal remains authoritative when cleanup intent storage is unavailable.
      }
      return hosts.filter((h) => h.id !== hostId)
    })
  } catch (error) {
    if (cleanupIntentRecorded) {
      await cancelCleanupForDurablyStoredHosts([hostId])
    }
    throw error
  }
  tokenCache.delete(hostId)
  try {
    await removeMobileRelayHostOverlay(hostId)
    hostListLoads.dropSharedHostListLoad()
  } catch {
    // Base removal is authoritative; a retained overlay can't resurrect the host and is cleaned on a later retry.
  }
  // Why: keychain delete can stall/reject; await only the durable cleanup intent so removeHost can't freeze the UI.
  try {
    await scheduleUnpairedHostCredentialCleanup(hostId)
  } catch {
    // Metadata is already committed; orphan-token recovery is best-effort.
  }
}

export async function retryPendingHostCredentialCleanup(): Promise<{
  clearedCount: number
  remainingIds: string[]
  storageUnreadable: boolean
}> {
  return retryPendingHostCredentialCleanups((hostId) =>
    deleteUnpairedHostCredentials(hostId, getHostCredentialWriteRevision(hostId))
  )
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
  resetHostCredentialWriteRevisionsForTests()
  hostListLoads.dropSharedHostListLoad()
  resetPairingKeychainForTests()
}
