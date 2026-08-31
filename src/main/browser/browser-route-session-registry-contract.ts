import type {
  BrowserRoutePartitionIdentity,
  DerivedBrowserRoutePartition
} from './browser-route-identity'
import type { BrowserRoutePageAuthorityRetirement } from './browser-route-page-authority'
import type { BrowserRouteElectronSession } from './browser-route-session-policy'

export type BrowserRoutePartitionBindingStore = {
  get(partition: string): string | null
  /** Returns partitions evicted to make room; their storage is now the caller's to destroy. */
  set(partition: string, fingerprint: string, storageScope: string): readonly string[]
  touch(partition: string): void
  findPartitionByFingerprint(fingerprint: string): string | null
  rebind(partition: string, fingerprint: string, storageScope: string): void
}

export type BrowserRouteSessionRegistryDependencies = {
  derivePartition?: (identity: BrowserRoutePartitionIdentity) => DerivedBrowserRoutePartition
  validateProfile(browserProfileId: string): void
  getSession(partition: string): BrowserRouteElectronSession
  setupPolicies(input: {
    partition: string
    browserProfileId: string
    session: BrowserRouteElectronSession
  }): void
  clearPolicies(input: { partition: string; session: BrowserRouteElectronSession }): void
  retirePageAuthority(input: BrowserRoutePageAuthorityRetirement): boolean
  bindingStore: BrowserRoutePartitionBindingStore
  /** Destroys the storage of partitions the binding store evicted at capacity. */
  releaseEvictedPartitions?: (partitions: readonly string[]) => void
  maxLivePartitions?: number
  maxPagesPerPartition?: number
}
