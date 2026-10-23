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
  /**
   * Identity the shipping build derives for the same route, when it differs from `identity`.
   * Every binding keeps this as its fingerprint, so a downgraded build still opens the jar.
   */
  compatibleIdentity?: BrowserRoutePartitionIdentity
  /** Identity of the superseded scheme, or null when there is nothing to adopt. */
  legacyIdentity: BrowserRoutePartitionIdentity | null
  storageScope: string
  derivePartition?: (identity: BrowserRoutePartitionIdentity) => DerivedBrowserRoutePartition
}

/** A resolved partition; a new binding also records `aliasFingerprint` beside its fingerprint. */
export type ResolvedBrowserRoutePartition = DerivedBrowserRoutePartition & {
  aliasFingerprint?: string
}

/**
 * Partition that holds `identity`'s browser storage, adopting an older name for it.
 *
 * Superseded identities hashed values that change without the server changing -- its
 * per-process `runtimeId`, or a re-paired server's pairing revision -- so deriving afresh
 * would hand the user an empty partition and log them out of every site. A binding already
 * minted from an older identity is adopted instead and keeps its cookies.
 *
 * When `compatibleIdentity` differs, the binding's fingerprint follows it and `identity`
 * rides along as an alias: the shipping build reads only the fingerprint, so a downgrade at
 * any pairing reopens the same jar. The returned fingerprint is always the binding's own.
 */
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
  // Re-points `partition` at the current pairing, unless an older build's jar already holds it.
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
    // Why: only this identity derives that name, so a binding there is its own jar whose alias
    // an older build's rewrite dropped.
    return alias ? adopt(derived.partition) : derived
  }
  const compatibleBound =
    alias && bindings.findPartitionByFingerprint(compatible.bindingFingerprint)
  if (compatibleBound) {
    return adopt(compatibleBound)
  }
  if (legacyIdentity !== null) {
    const legacy = derive(legacyIdentity)
    // Why: adopt only a partition this exact legacy identity minted -- any other binding
    // on that name belongs to a different route and must keep its own storage.
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
