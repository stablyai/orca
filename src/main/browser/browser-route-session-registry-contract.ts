import type { BrowserClientProfileMetadata } from '../../shared/browser-client-profile-switch-protocol'
import type {
  BrowserRoutePartitionIdentity,
  DerivedBrowserRoutePartition
} from './browser-route-identity'
import type { BrowserRoutePageAuthorityRetirement } from './browser-route-page-authority'
import type { BrowserRouteElectronSession } from './browser-route-session-policy'

export type BrowserRoutePartitionBindingStore = {
  get(partition: string): string | null
  /** Returns evicted partitions whose storage the caller must destroy. */
  set(
    partition: string,
    fingerprint: string,
    storageScope: string,
    alias?: string
  ): readonly string[]
  touch(partition: string): void
  findPartitionByFingerprint(fingerprint: string): string | null
  rebind(partition: string, fingerprint: string, storageScope: string, alias?: string): void
}

export type BrowserRouteSessionRegistryDependencies = {
  derivePartition?: (identity: BrowserRoutePartitionIdentity) => DerivedBrowserRoutePartition
  validateProfile(browserProfileId: string, metadata?: BrowserClientProfileMetadata): void
  getSession(partition: string): BrowserRouteElectronSession
  setupPolicies(input: {
    profileMetadata?: BrowserClientProfileMetadata
    partition: string
    browserProfileId: string
    session: BrowserRouteElectronSession
  }): void | Promise<void>
  clearPolicies(input: { partition: string; session: BrowserRouteElectronSession }): void
  retirePageAuthority(input: BrowserRoutePageAuthorityRetirement): boolean
  bindingStore: BrowserRoutePartitionBindingStore
  releaseEvictedPartitions?: (partitions: readonly string[]) => void
  maxLivePartitions?: number
  maxPagesPerPartition?: number
}
