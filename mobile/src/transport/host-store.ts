import type { MobileRelayEndpoint } from '../../../src/shared/mobile-relay-credential-contract'
import { HostProfileSchema } from './types'
import type { HostCatalogEntry, HostProfile, StoredHostProfile } from './types'
import { getNextHostNameFromHosts } from './host-names'
import { mergeHostNameIdentity, withPersonalName } from './host-name-identity'
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
  loadMobileRelayHostRoutingState,
  removeMobileRelayHostRouting,
  removeMobileRelayHostRoutings,
  saveMobileRelayHostRouting
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
import {
  enqueueHostListMutation,
  hostListMutationsSettled,
  mutateStoredHosts,
  resetHostListMutationQueueForTests
} from './host-list-mutation-queue'

async function commitDeviceToken(hostId: string, token: string): Promise<void> {
  markHostCredentialWrite(hostId)
  await writeHostDeviceToken(hostId, token)
  tokenCache.set(hostId, token)
  hostListLoads.dropSharedHostListLoad()
}

// Cache slow keychain reads per host; invalidate on save/remove.
const tokenCache = new Map<string, string>()

export const loadHosts = async (): Promise<HostProfile[]> => (await loadHostListSnapshot()).profiles
export const loadHostCatalog = async (): Promise<HostCatalogEntry[]> =>
  (await loadHostListSnapshot()).catalog

async function loadHostListSnapshot(): Promise<hostListLoads.HostListSnapshot> {
  // Wait for full serialized mutations so loads cannot read half-written state.
  await hostListMutationsSettled()
  return hostListLoads.shareHostListLoad(doLoadHostListSnapshot)
}

async function doLoadHostListSnapshot(): Promise<hostListLoads.HostListSnapshot> {
  const storedHosts = await loadStoredHostProfiles()
  if (!storedHosts) {
    return { catalog: [], profiles: [] }
  }
  const overlayState = await loadMobileRelayHostRoutingState(
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
    relays: overlayState.relays,
    tokenCache,
    readToken: readHostDeviceToken,
    getRevision: hostListLoads.getHostListLoadRevision
  })
}

export async function resolvePairingHostIdentity(
  publicKeyB64: string,
  newHostId: string
): Promise<{ id: string; name: string }> {
  await hostListMutationsSettled()
  const hosts = await readStoredHostProfilesForMutation()
  const match = hosts.find((host) => host.publicKeyB64 === publicKeyB64)
  return match
    ? { id: match.id, name: match.name }
    : { id: newHostId, name: getNextHostNameFromHosts(hosts) }
}

const deleteUnpairedHostCredentials = createUnpairedHostCredentialDeletion({
  waitForHostMutations: hostListMutationsSettled,
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
  void enqueueHostListMutation(async () => {
    const hosts = await readStoredHostProfilesForMutation()
    if (hosts.some(({ id }) => id === hostId)) {
      // Register before later removals enqueue their intent, without blocking host loads on cleanup storage.
      void cancelPendingHostCredentialCleanup(hostId).catch(() => undefined)
    }
  }).catch(() => {})
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

function removeOrphanOverlayIfUnpaired(hostId: string): Promise<void> {
  return enqueueHostListMutation(async () => {
    const hosts = await readStoredHostProfilesForMutation()
    if (!hosts.some(({ id }) => id === hostId)) {
      await removeMobileRelayHostRouting(hostId)
    }
  })
}

export { updateHostDescriptor } from './host-descriptor-persistence'

export class RelayRoutingHostRemovedError extends Error {}

// Persist learned relay routing only; pairing/Edit Host retain authority over host rows and tokens.
export async function setRelayRouting(hostId: string, relay: MobileRelayEndpoint): Promise<void> {
  const wrote = await enqueueHostListMutation(async () => {
    const hosts = await readStoredHostProfilesForMutation()
    if (!hosts.some(({ id }) => id === hostId)) {
      // Why: an in-flight relay learner must not resurrect a host the user removed.
      throw new RelayRoutingHostRemovedError('mobile relay host was removed')
    }
    return saveMobileRelayHostRouting(hostId, relay)
  })
  if (wrote) {
    hostListLoads.dropSharedHostListLoad()
  }
}

/** Pairing only (a census fences the importers): it creates or re-pairs the whole host. */
export async function savePairedHost(host: HostProfile): Promise<void> {
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
      if (index !== -1) {
        updatedExistingHost = true
        // Deduplicate same-key rows only during authoritative save while preserving host identity.
        next = hosts
          .filter(({ id }) => !duplicateHostIds.has(id))
          .map((candidate) =>
            candidate.id === stored.id ? mergeHostNameIdentity(stored, candidate) : candidate
          )
      } else {
        next = [...hosts.filter(({ id }) => !duplicateHostIds.has(id)), stored]
      }
      if (duplicateHostIds.size > 0) {
        if (index === -1) {
          // Persist cleanup intent before publishing credentials so process death cannot orphan early token writes.
          await recordHostCredentialCleanupIntent(stored.id)
          cleanupIntentRecordedBeforeMetadata = true
        }
        for (const duplicateHostId of duplicateHostIds) {
          await recordHostCredentialCleanupIntent(duplicateHostId)
        }
        // Keep the usable same-key row until replacement credentials are durable.
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
    // Surface token-write failure in the catalog so recovery can retain the host.
    await commitDeviceToken(stored.id, validated.deviceToken)
  }
  // Cancel cleanup only while this publication remains authoritative; later removal owns its own intent.
  cancelCleanupForStoredHost(stored.id)
  if (validated.relay) {
    await saveMobileRelayHostRouting(stored.id, validated.relay)
    hostListLoads.dropSharedHostListLoad()
  }
  const overlayRemovalIds = [...duplicateHostIds]
  if (!validated.relay && updatedExistingHost) {
    overlayRemovalIds.push(stored.id)
  }
  if (overlayRemovalIds.length > 0) {
    // Clear old routing when direct-only re-pairing reuses the host id.
    await removeMobileRelayHostRoutings(overlayRemovalIds)
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
    await removeMobileRelayHostRouting(hostId)
    hostListLoads.dropSharedHostListLoad()
  } catch {
    // Base removal is authoritative; a retained overlay can't resurrect the host and is cleaned on a later retry.
  }
  // Await durable cleanup intent, not a potentially stalled keychain delete, so host removal stays responsive.
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

// Commit name/endpoint atomically; personalName:null clears the phone override in favor of the reported name.
export async function updateHostNameAndEndpoint(
  hostId: string,
  updates: { personalName?: string | null; endpoint?: string }
): Promise<void> {
  await mutateStoredHosts((hosts) => {
    const index = hosts.findIndex((host) => host.id === hostId)
    if (index === -1) {
      throw new Error('Host not found')
    }
    let updated: StoredHostProfile = {
      ...hosts[index]!,
      ...(updates.endpoint !== undefined ? { endpoint: updates.endpoint } : {})
    }
    if (updates.personalName !== undefined) {
      updated = withPersonalName(updated, updates.personalName, hosts)
    }
    const next = hosts.slice()
    next[index] = updated
    return next
  })
}

export async function updateLastConnected(hostId: string): Promise<void> {
  try {
    await mutateStoredHosts((hosts) => {
      const index = hosts.findIndex((h) => h.id === hostId)
      if (index === -1) {
        return hosts
      }
      const next = hosts.slice()
      next[index] = { ...next[index]!, lastConnected: Date.now() }
      return next
    })
  } catch {
    // Swallow bookkeeping failures because void callers cannot catch them.
  }
}

export function resetHostStoreForTests(): void {
  resetHostListMutationQueueForTests()
  tokenCache.clear()
  resetHostCredentialWriteRevisionsForTests()
  hostListLoads.dropSharedHostListLoad()
  resetPairingKeychainForTests()
}
