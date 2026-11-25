import {
  deriveBrowserRoutePartition,
  type BrowserRoutePartitionIdentity,
  type DerivedBrowserRoutePartition
} from './browser-route-identity'

export type BrowserRoutePartitionMigrationStore = {
  get(partition: string): string | null
  findPartitionByFingerprint(fingerprint: string): string | null
  rebind(partition: string, fingerprint: string, storageScope: string, alias?: string): void
}

export type BrowserRoutePartitionMigration = {
  bindings: BrowserRoutePartitionMigrationStore
  identity: BrowserRoutePartitionIdentity
  /** Keep the older build's fingerprint so downgrades reopen the same storage. */
  compatibleIdentity?: BrowserRoutePartitionIdentity
  legacyIdentity: BrowserRoutePartitionIdentity | null
  storageScope: string
  derivePartition?: (identity: BrowserRoutePartitionIdentity) => DerivedBrowserRoutePartition
}

export type ResolvedBrowserRoutePartition = DerivedBrowserRoutePartition & {
  aliasFingerprint?: string
}

// Adopt old partition names to preserve cookies across restarts and re-pairing.
export function resolveBrowserRoutePartitionBinding(
  migration: BrowserRoutePartitionMigration
): ResolvedBrowserRoutePartition {
  const { bindings, legacyIdentity, storageScope } = migration
  const derive = migration.derivePartition ?? deriveBrowserRoutePartition
  const derived = derive(migration.identity)
  const compatible = migration.compatibleIdentity ? derive(migration.compatibleIdentity) : derived
  const alias =
    compatible.bindingFingerprint === derived.bindingFingerprint
      ? undefined
      : derived.bindingFingerprint
  // Preserve this partition's fingerprint if another partition already holds the compatible one.
  const adopt = (partition: string): ResolvedBrowserRoutePartition => {
    const holder = bindings.findPartitionByFingerprint(compatible.bindingFingerprint)
    const fingerprint =
      holder === null || holder === partition
        ? compatible.bindingFingerprint
        : (bindings.get(partition) ?? compatible.bindingFingerprint)
    bindings.rebind(partition, fingerprint, storageScope, alias)
    return { partition, bindingFingerprint: fingerprint }
  }
  const bound = bindings.findPartitionByFingerprint(derived.bindingFingerprint)
  if (bound !== null) {
    return alias && bindings.get(bound) !== compatible.bindingFingerprint
      ? adopt(bound)
      : { partition: bound, bindingFingerprint: bindings.get(bound) ?? derived.bindingFingerprint }
  }
  if (bindings.get(derived.partition) !== null) {
    // An older build may have rewritten this identity's binding without its alias.
    return alias ? adopt(derived.partition) : derived
  }
  const compatibleBound =
    alias && bindings.findPartitionByFingerprint(compatible.bindingFingerprint)
  if (compatibleBound) {
    return adopt(compatibleBound)
  }
  if (legacyIdentity !== null) {
    const legacy = derive(legacyIdentity)
    // Adopt only an exact legacy fingerprint to avoid taking another route's storage.
    if (
      legacy.partition !== derived.partition &&
      bindings.get(legacy.partition) === legacy.bindingFingerprint
    ) {
      bindings.rebind(legacy.partition, compatible.bindingFingerprint, storageScope, alias)
      return { partition: legacy.partition, bindingFingerprint: compatible.bindingFingerprint }
    }
  }
  return alias
    ? {
        partition: derived.partition,
        bindingFingerprint: compatible.bindingFingerprint,
        aliasFingerprint: alias
      }
    : derived
}
