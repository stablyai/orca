import type { BrowserClientPageAuthorityIdentity } from '../../client-pages/execution/browser-client-page-command-executor-dependencies'
import { getBrowserClientHostId } from './browser-client-host-id'

export type ClientHostRouteIdentity = BrowserClientPageAuthorityIdentity & {
  orcaProfileId: string
  /** Pairs with `authorityConnectionIdentity` and `pairingAuthorityConnectionIdentity`. */
  executionHostIdentity: string
  /** Pairs with `legacyAuthorityConnectionIdentity`, naming the partition an older build populated. */
  legacyExecutionHostIdentity: string
  storageScope: string
}

let activeOrcaProfileId: string | null = null
// Storage operations need a route identity even without an open page.
export const clientHostRouteIdentities = new Map<string, ClientHostRouteIdentity>()
let hostPageQuery: ((environmentId: string, browserPageId: string) => boolean) | null = null

export function configurePairedRuntimeBrowserClientHostsForOrcaProfile(options: {
  orcaProfileId: string
}): void {
  if (activeOrcaProfileId && activeOrcaProfileId !== options.orcaProfileId) {
    throw new Error('paired_runtime_browser_client_host_profile_conflict')
  }
  activeOrcaProfileId = options.orcaProfileId
}

export function getActivePairedRuntimeBrowserOrcaProfileId(): string | null {
  return activeOrcaProfileId
}

export function getPairedRuntimeBrowserClientRouteIdentity(
  environmentId: string
): ClientHostRouteIdentity | null {
  return clientHostRouteIdentities.get(environmentId) ?? null
}

export function pairedRuntimeBrowserClientHostId(environmentId: string): string | null {
  return clientHostRouteIdentities.has(environmentId) ? getBrowserClientHostId() : null
}

export function registerPairedRuntimeBrowserClientHostPageQuery(
  query: (environmentId: string, browserPageId: string) => boolean
): void {
  hostPageQuery = query
}

export function hasLoadedPairedRuntimeBrowserClientHosts(): boolean {
  return hostPageQuery !== null
}

export function pairedRuntimeBrowserClientHostsPage(
  environmentId: string,
  browserPageId: string
): boolean {
  return hostPageQuery ? hostPageQuery(environmentId, browserPageId) : false
}
