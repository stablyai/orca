import {
  deriveBrowserRoutePartition,
  type BrowserRoutePartitionIdentity,
  type DerivedBrowserRoutePartition
} from './browser-route-identity'

export type BrowserRoutePartitionMigrationStore = {
  get(partition: string): string | null
  findPartitionByFingerprint(fingerprint: string): string | null
  rebind(partition: string, fingerprint: string, storageScope: string): void
}

export type BrowserRoutePartitionMigration = {
  bindings: BrowserRoutePartitionMigrationStore
  identity: BrowserRoutePartitionIdentity
  /** Identity of the superseded scheme, or null when there is nothing to adopt. */
  legacyIdentity: BrowserRoutePartitionIdentity | null
  storageScope: string
  derivePartition?: (identity: BrowserRoutePartitionIdentity) => DerivedBrowserRoutePartition
}

/**
 * Partition that holds `identity`'s browser storage, adopting an older name for it.
 *
 * The superseded identity hashed the paired server's per-process `runtimeId`, so
 * deriving afresh would hand an upgraded client an empty partition and log the
 * user out of every site. A binding already minted from `legacyIdentity` is
 * re-pointed at the durable fingerprint instead, and keeps its cookies. Once
 * adopted, the fingerprint alone resolves the partition, so the legacy name is
 * never needed again -- including after the server restarts.
 */
export function resolveBrowserRoutePartitionBinding(
  migration: BrowserRoutePartitionMigration
): DerivedBrowserRoutePartition {
  const { bindings, legacyIdentity, storageScope } = migration
  const derive = migration.derivePartition ?? deriveBrowserRoutePartition
  const derived = derive(migration.identity)
  const bound = bindings.findPartitionByFingerprint(derived.bindingFingerprint)
  if (bound !== null) {
    return { partition: bound, bindingFingerprint: derived.bindingFingerprint }
  }
  if (legacyIdentity === null || bindings.get(derived.partition) !== null) {
    return derived
  }
  const legacy = derive(legacyIdentity)
  // Why: adopt only a partition this exact legacy identity minted -- any other binding
  // on that name belongs to a different route and must keep its own storage.
  if (
    legacy.partition === derived.partition ||
    bindings.get(legacy.partition) !== legacy.bindingFingerprint
  ) {
    return derived
  }
  bindings.rebind(legacy.partition, derived.bindingFingerprint, storageScope)
  return { partition: legacy.partition, bindingFingerprint: derived.bindingFingerprint }
}
