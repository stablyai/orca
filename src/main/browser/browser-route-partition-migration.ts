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
  /** Identities of superseded schemes for this same route, most recent first. */
  legacyIdentities: readonly BrowserRoutePartitionIdentity[]
  storageScope: string
  derivePartition?: (identity: BrowserRoutePartitionIdentity) => DerivedBrowserRoutePartition
}

/**
 * Partition that holds `identity`'s browser storage, adopting an older name for it.
 *
 * Superseded identities hashed inputs that churn -- the paired server's per-process
 * `runtimeId`, or a managed host's pairing revision and device -- so deriving afresh
 * would hand an upgraded client an empty partition and log the user out of every
 * site. A partition already bound to a legacy identity's fingerprint is re-pointed
 * at the durable fingerprint instead, and keeps its cookies. Once adopted, the
 * fingerprint alone resolves the partition, so the legacy names are never needed
 * again -- including after the server restarts or re-pairs.
 *
 * Downgrade: an older build cannot resolve an adopted binding, so it either refuses with
 * `browser_route_partition_binding_conflict` or derives an empty partition. The logins stay
 * hidden until the user upgrades again; nothing is deleted.
 */
export function resolveBrowserRoutePartitionBinding(
  migration: BrowserRoutePartitionMigration
): DerivedBrowserRoutePartition {
  const { bindings, storageScope } = migration
  const derive = migration.derivePartition ?? deriveBrowserRoutePartition
  const derived = derive(migration.identity)
  const bound = bindings.findPartitionByFingerprint(derived.bindingFingerprint)
  if (bound !== null) {
    return { partition: bound, bindingFingerprint: derived.bindingFingerprint }
  }
  const legacyFingerprints = migration.legacyIdentities.map(
    (legacyIdentity) => derive(legacyIdentity).bindingFingerprint
  )
  const adopted = adoptablePartition(bindings, derived.partition, legacyFingerprints)
  if (adopted === null) {
    return derived
  }
  bindings.rebind(adopted, derived.bindingFingerprint, storageScope)
  return { partition: adopted, bindingFingerprint: derived.bindingFingerprint }
}

function adoptablePartition(
  bindings: BrowserRoutePartitionMigrationStore,
  derivedPartition: string,
  legacyFingerprints: readonly string[]
): string | null {
  const holder = bindings.get(derivedPartition)
  if (holder !== null) {
    // Why: a held name stays put -- reclaimed only when a legacy scheme of this route holds it,
    // otherwise left for the caller's conflict check rather than abandoning that jar.
    return legacyFingerprints.includes(holder) ? derivedPartition : null
  }
  for (const fingerprint of legacyFingerprints) {
    // Why by fingerprint: an earlier adoption may have kept an older name, and only a
    // partition this exact legacy identity owns may be taken over.
    const partition = bindings.findPartitionByFingerprint(fingerprint)
    if (partition !== null) {
      return partition
    }
  }
  return null
}

export type BrowserRouteSupersededIdentitySource = {
  orcaProfileId: string
  browserProfileId: string
  executionHostIdentity: string
  adoptableAuthorityConnectionIdentities: readonly string[]
  legacyAuthorityConnectionIdentity: string
  legacyExecutionHostIdentity: string
}

/** Superseded identities of one route, most recent scheme first, for `legacyIdentities`. */
export function supersededBrowserRoutePartitionIdentities(
  source: BrowserRouteSupersededIdentitySource
): BrowserRoutePartitionIdentity[] {
  const { orcaProfileId, browserProfileId } = source
  return [
    ...source.adoptableAuthorityConnectionIdentities.map((authorityConnectionIdentity) => ({
      orcaProfileId,
      browserProfileId,
      authorityConnectionIdentity,
      executionHostIdentity: source.executionHostIdentity
    })),
    {
      orcaProfileId,
      browserProfileId,
      authorityConnectionIdentity: source.legacyAuthorityConnectionIdentity,
      executionHostIdentity: source.legacyExecutionHostIdentity
    }
  ]
}
