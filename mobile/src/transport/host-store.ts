import { deleteMobileWebPagePreferences } from '../mobile-web/mobile-web-page-preferences-store'
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
  toStoredHostProfile
} from './host-metadata-store'
import * as hostListMutations from './host-list-mutation-queue'

async function commitDeviceToken(hostId: string, token: string): Promise<void> {
  markHostCredentialWrite(hostId)
  await writeHostDeviceToken(hostId, token)
  tokenCache.set(hostId, token)
  hostListLoads.dropSharedHostListLoad()
}

// Why: Keychain reads are slow (50-200ms) and loadHosts() runs on every screen mount; cache per-hostId in memory, invalidate on save/remove.
const tokenCache = new Map<string, string>()
export const loadHosts = async (): Promise<HostProfile[]> => (await loadHostListSnapshot()).profiles
export const loadHostCatalog = async (): Promise<HostCatalogEntry[]> =>
  (await loadHostListSnapshot()).catalog

async function loadHostListSnapshot(): Promise<hostListLoads.HostListSnapshot> {
  await hostListMutations.waitForHostListMutations()
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
  await hostListMutations.waitForHostListMutations()
  const hosts = await readStoredHostProfilesForMutation()
  const match = hosts.find((host) => host.publicKeyB64 === publicKeyB64)
  return match
    ? { id: match.id, name: match.name }
    : { id: newHostId, name: getNextHostNameFromHosts(hosts) }
}

const deleteUnpairedHostCredentials = createUnpairedHostCredentialDeletion({
  waitForHostMutations: hostListMutations.waitForHostListMutations,
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
  void hostListMutations
    .enqueueHostListMutation(async () => {
      const hosts = await readStoredHostProfilesForMutation()
      if (hosts.some(({ id }) => id === hostId)) {
        // Register before later removals enqueue their intent, without blocking host loads on cleanup storage.
        void cancelPendingHostCredentialCleanup(hostId).catch(() => undefined)
      }
    })
    .catch(() => undefined)
}

async function cancelCleanupForDurablyStoredHosts(hostIds: Iterable<string>): Promise<void> {
  const targets = [...hostIds]
  return hostListMutations
    .enqueueHostListMutation(async () => {
      const storedIds = new Set((await readStoredHostProfilesForMutation()).map(({ id }) => id))
      await Promise.all(
        targets
          .filter((hostId) => storedIds.has(hostId))
          .map((hostId) => cancelPendingHostCredentialCleanup(hostId).catch(() => undefined))
      )
    })
    .catch(() => undefined)
}

function removeOrphanOverlayIfUnpaired(hostId: string): Promise<void> {
  return hostListMutations.enqueueHostListMutation(async () => {
    const hosts = await readStoredHostProfilesForMutation()
    if (!hosts.some(({ id }) => id === hostId)) {
      await removeMobileRelayHostOverlay(hostId)
    }
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
    await hostListMutations.mutateStoredHosts(async (hosts) => {
      const index = hosts.findIndex((h) => h.id === stored.id)
      for (const candidate of hosts) {
        if (candidate.id !== stored.id && candidate.publicKeyB64 === stored.publicKeyB64) {
          duplicateHostIds.add(candidate.id)
        }
      }
      let next: StoredHostProfile[]
      if (index !== -1) {
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
        if (index === -1) {
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
  let orphanedPublicKeyB64: string | null = null
  try {
    await hostListMutations.mutateStoredHosts(async (hosts) => {
      try {
        await recordHostCredentialCleanupIntent(hostId)
        cleanupIntentRecorded = true
      } catch {
        // Removal remains authoritative when cleanup intent storage is unavailable.
      }
      const removedKey = hosts.find((h) => h.id === hostId)?.publicKeyB64
      const remaining = hosts.filter((h) => h.id !== hostId)
      // Hosted page preferences are keyed by a pairing key a sibling row may still hold.
      if (removedKey && !remaining.some((h) => h.publicKeyB64 === removedKey)) {
        orphanedPublicKeyB64 = removedKey
      }
      return remaining
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
  try {
    if (orphanedPublicKeyB64) {
      await deleteMobileWebPagePreferences(orphanedPublicKeyB64)
    }
  } catch {
    // Base removal is authoritative; an orphaned preference blob is inert without the pairing.
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
  await hostListMutations.mutateStoredHosts((hosts) => {
    const index = hosts.findIndex((host) => host.id === hostId)
    if (index === -1) {
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
    await hostListMutations.mutateStoredHosts((hosts) => {
      const index = hosts.findIndex((h) => h.id === hostId)
      if (index === -1) {
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
  hostListMutations.resetHostListMutationQueueForTests()
  tokenCache.clear()
  resetHostCredentialWriteRevisionsForTests()
  hostListLoads.dropSharedHostListLoad()
  resetPairingKeychainForTests()
}
