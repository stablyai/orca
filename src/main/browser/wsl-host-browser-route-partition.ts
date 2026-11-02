/**
 * The route partition a WSL host's in-app browser pages will use, resolved from the environment
 * record alone so a caller can seed it while no page or orcad connection is live.
 */
import { classifyRuntimeEnvironmentHost } from '../../shared/runtime-environment-host-kind'
import {
  getPreferredPairedRuntimeConnection,
  type KnownRuntimeEnvironment
} from '../../shared/runtime-environments'
import { browserAuthorityExecutionHostStorageIdentity } from './browser-execution-host-storage-identity'
import {
  deriveBrowserRoutePartitionStorageScope,
  type BrowserRoutePartitionIdentity
} from './browser-route-identity'
import { currentBrowserRoutePartitionBindingStore } from './browser-route-partition-binding-runtime'
import { resolveBrowserRoutePartitionBinding } from './browser-route-partition-migration'
import { isBrowserRoutePartitionRetainedByAnyOwner } from './browser-route-partition-retention'
import { releaseEvictedBrowserRoutePartitionStorage } from './browser-route-partition-storage-dependencies'
import { derivePairedRuntimeBrowserAuthorityIdentity } from './paired-runtime-browser-authority-identity'

// Only the per-process legacy identity reads the runtime id, and it is not used here.
const OFFLINE_AUTHORITY_RUNTIME_ID = 'wsl-move-offline'

export type WslHostBrowserRouteStorage = {
  orcaProfileId: string
  storageScope: string
  /** Survives re-pairs; pages find the jar through it. */
  authorityConnectionIdentity: string
  /** The current pairing's identity, which the binding keeps as its fingerprint for downgrades. */
  pairingAuthorityConnectionIdentity: string
}

export type WslHostBrowserRouteStorageResult =
  | { kind: 'stable'; storage: WslHostBrowserRouteStorage }
  | { kind: 'unavailable'; reason: 'destination-not-wsl-host' | 'no-stable-partition' }

/** `stable` only for a WSL host whose partition survives every orcad relaunch and re-pair. */
export function wslHostBrowserRouteStorage(
  orcaProfileId: string,
  environment: KnownRuntimeEnvironment
): WslHostBrowserRouteStorageResult {
  // Why first: without a deployment link the identity is pairing-scoped, so no host kind is stable.
  if (!environment.orcadDeployment) {
    return { kind: 'unavailable', reason: 'no-stable-partition' }
  }
  if (classifyRuntimeEnvironmentHost(environment).kind !== 'wsl') {
    return { kind: 'unavailable', reason: 'destination-not-wsl-host' }
  }
  const identity = derivePairedRuntimeBrowserAuthorityIdentity({
    orcaProfileId,
    environment,
    pairingRevision: environment.pairingRevision ?? environment.createdAt,
    authorityRuntimeId: OFFLINE_AUTHORITY_RUNTIME_ID,
    connection: getPreferredPairedRuntimeConnection(environment)
  })
  // Why: a pairing-scoped identity moves on the next orcad relaunch, stranding anything copied.
  if (identity.authorityConnectionIdentity === identity.pairingAuthorityConnectionIdentity) {
    return { kind: 'unavailable', reason: 'no-stable-partition' }
  }
  return {
    kind: 'stable',
    storage: {
      orcaProfileId,
      storageScope: deriveBrowserRoutePartitionStorageScope({
        orcaProfileId,
        environmentId: environment.id
      }),
      authorityConnectionIdentity: identity.authorityConnectionIdentity,
      pairingAuthorityConnectionIdentity: identity.pairingAuthorityConnectionIdentity
    }
  }
}

/**
 * Binds (or adopts, as the first page would) the host's partition for one browser profile.
 * Throws `browser_route_partition_binding_conflict` when another identity owns the name.
 */
export function bindWslHostBrowserRoutePartition(
  storage: WslHostBrowserRouteStorage,
  browserProfileId: string
): string {
  // Why: the host's own pages run natively inside the distro, so they name the authority itself.
  const executionHostIdentity = browserAuthorityExecutionHostStorageIdentity(storage.storageScope)
  const identity = (authorityConnectionIdentity: string): BrowserRoutePartitionIdentity => ({
    orcaProfileId: storage.orcaProfileId,
    browserProfileId,
    authorityConnectionIdentity,
    executionHostIdentity
  })
  const bindings = currentBrowserRoutePartitionBindingStore({
    isPartitionRetained: isBrowserRoutePartitionRetainedByAnyOwner
  })
  // Why no legacy identity: it hashes the live orcad's runtime id, so a jar bound to it is only
  // adoptable by a page of that same orcad process.
  const derived = resolveBrowserRoutePartitionBinding({
    bindings,
    identity: identity(storage.authorityConnectionIdentity),
    compatibleIdentity: identity(storage.pairingAuthorityConnectionIdentity),
    legacyIdentity: null,
    storageScope: storage.storageScope
  })
  const persisted = bindings.get(derived.partition)
  if (persisted === null) {
    const evicted = bindings.set(
      derived.partition,
      derived.bindingFingerprint,
      storage.storageScope,
      derived.aliasFingerprint
    )
    if (evicted.length > 0) {
      void releaseEvictedBrowserRoutePartitionStorage(
        evicted,
        isBrowserRoutePartitionRetainedByAnyOwner
      )
    }
  } else if (persisted !== derived.bindingFingerprint) {
    throw new Error('browser_route_partition_binding_conflict')
  } else {
    bindings.touch(derived.partition)
  }
  return derived.partition
}
