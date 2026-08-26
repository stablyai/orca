import type {
  BrowserRoutePartitionIdentity,
  DerivedBrowserRoutePartition
} from './browser-route-identity'
import { resolveBrowserRoutePartitionBinding } from './browser-route-partition-migration'
import type { BrowserRouteSessionRegistryDependencies } from './browser-route-session-registry-contract'
import type { BrowserRoutePreparePageInput } from './browser-route-session-state'

/** Partition this page belongs in, refusing a name another identity already owns. */
export function resolveBrowserRouteSessionPartition(
  dependencies: BrowserRouteSessionRegistryDependencies,
  input: BrowserRoutePreparePageInput,
  derivePartition: (identity: BrowserRoutePartitionIdentity) => DerivedBrowserRoutePartition
): DerivedBrowserRoutePartition {
  const derived = resolveBrowserRoutePartitionBinding({
    bindings: dependencies.bindingStore,
    identity: input.identity,
    legacyIdentity: input.legacyIdentity ?? null,
    storageScope: input.storageScope,
    derivePartition
  })
  const persisted = dependencies.bindingStore.get(derived.partition)
  if (persisted !== null && persisted !== derived.bindingFingerprint) {
    throw new Error('browser_route_partition_binding_conflict')
  }
  return derived
}

/**
 * Records the binding before the partition is prepared, so metadata never lags storage.
 *
 * Evicted partitions come back from the store with their metadata already dropped, so
 * their storage is destroyed here rather than left as disk nothing can collect.
 */
export function persistBrowserRouteSessionBinding(
  dependencies: BrowserRouteSessionRegistryDependencies,
  derived: DerivedBrowserRoutePartition,
  storageScope: string
): void {
  if (dependencies.bindingStore.get(derived.partition) !== null) {
    dependencies.bindingStore.touch(derived.partition)
    return
  }
  const evicted = dependencies.bindingStore.set(
    derived.partition,
    derived.bindingFingerprint,
    storageScope
  )
  if (evicted.length > 0) {
    dependencies.releaseEvictedPartitions?.(evicted)
  }
}
