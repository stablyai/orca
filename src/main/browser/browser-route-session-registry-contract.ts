import type {
  BrowserRoutePartitionIdentity,
  DerivedBrowserRoutePartition
} from './browser-route-identity'
import type { BrowserRoutePageAuthorityRetirement } from './browser-route-page-authority'
import type { BrowserRouteElectronSession } from './browser-route-session-policy'

export type BrowserRoutePartitionBindingStore = {
  get(partition: string): string | null
  set(partition: string, fingerprint: string): void
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
  maxLivePartitions?: number
  maxPagesPerPartition?: number
}
