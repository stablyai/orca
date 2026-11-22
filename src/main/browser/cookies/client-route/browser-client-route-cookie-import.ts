import type {
  BrowserCookieImportResult,
  BrowserCookieImportSelection,
  BrowserSessionProfileSource
} from '../../../../shared/browser/workspaces/browser-workspace-types'
import {
  browserCookieImportFailure,
  type BrowserCookieImportFailure
} from '../../../../shared/browser/cookies/browser-cookie-import-failure-copy'
import { openClientRouteCookieImportSources } from './client-route-cookie-import-source-store'
import {
  browserCookieImportSource,
  cookieFileImportSource,
  importIntoRoutePartition,
  type RouteCookieImportSource
} from '../route-partition/browser-route-partition-cookie-import'
import { currentBrowserRoutePartitionBindingStore } from '../../routing/partitions/browser-route-partition-binding-runtime'
import { resolveBrowserRoutePartitionBinding } from '../../routing/partitions/browser-route-partition-migration'
import { browserSessionRegistry } from '../../sessions/profiles/browser-session-registry'
import { getPairedRuntimeBrowserClientRouteIdentity } from '../../client-hosts/lifecycle/paired-runtime-browser-client-host-runtime'

type ClientRouteCookieImportTarget = {
  environmentId: string
  browserProfileId: string
}

export type ClientRouteCookieImportRequest = ClientRouteCookieImportTarget &
  BrowserCookieImportSelection

/** Main derives the destination partition; null delegates to the server-side import RPC. */
export async function importCookiesIntoClientRoutePartition(
  request: ClientRouteCookieImportRequest
): Promise<BrowserCookieImportResult | null> {
  return importIntoClientRoutePartition(request, async (previous) =>
    browserCookieImportSource(request, previous)
  )
}

/** Null when this desktop does not host the environment's pages; a remote file is never read. */
export async function importCookieFileIntoClientRoutePartition(
  target: ClientRouteCookieImportTarget,
  pickFile: () => Promise<string | null>
): Promise<BrowserCookieImportResult | null> {
  return importIntoClientRoutePartition(target, () => cookieFileImportSource(pickFile))
}

async function importIntoClientRoutePartition(
  target: ClientRouteCookieImportTarget,
  resolveSource: (
    previous: BrowserSessionProfileSource | undefined
  ) => Promise<RouteCookieImportSource | BrowserCookieImportFailure>
): Promise<BrowserCookieImportResult | null> {
  const routeIdentity = getPairedRuntimeBrowserClientRouteIdentity(target.environmentId)
  if (!routeIdentity) {
    return null
  }
  const profile = browserSessionRegistry.getProfile(target.browserProfileId)
  if (!profile) {
    return browserCookieImportFailure('profileNotFound')
  }
  const sourceStore = await openClientRouteCookieImportSources(
    target.environmentId,
    routeIdentity.authorityConnectionIdentity
  )
  const imported = await importIntoRoutePartition(
    {
      // Bound to the pairing the request saw; a re-pair while picking must not redirect it.
      bindPartition: () => bindRoutePartition(routeIdentity, target.browserProfileId),
      currentPartition: () => settledRoutePartition(target),
      // Re-pairing while picking or importing changes the destination; reject a stale success.
      routeChanged: (settled) =>
        browserCookieImportFailure(settled === null ? 'connectionEnded' : 'serverRepaired')
    },
    () => resolveSource(sourceStore.sources[target.browserProfileId])
  )
  if (!imported.ok) {
    return imported
  }
  // Badge this desktop’s server-route jar, rather than the local profile jar.
  sourceStore.record(target.browserProfileId, imported.source.importedSource())
  return {
    ...imported.result,
    profileId: target.browserProfileId,
    googleCookieClearTarget: {
      label: profile.label,
      local: {
        profileId: profile.id,
        environmentId: target.environmentId,
        partition: imported.partition,
        routeIdentity: JSON.stringify(routeIdentity)
      }
    }
  }
}

function settledRoutePartition(target: ClientRouteCookieImportTarget): string | null {
  const routeIdentity = getPairedRuntimeBrowserClientRouteIdentity(target.environmentId)
  return routeIdentity ? bindRoutePartition(routeIdentity, target.browserProfileId) : null
}

export function bindRoutePartition(
  routeIdentity: NonNullable<ReturnType<typeof getPairedRuntimeBrowserClientRouteIdentity>>,
  browserProfileId: string
): string {
  browserSessionRegistry.requireRouteBrowserProfile(browserProfileId)
  const bindings = currentBrowserRoutePartitionBindingStore()
  const derived = resolveBrowserRoutePartitionBinding({
    bindings,
    identity: {
      orcaProfileId: routeIdentity.orcaProfileId,
      browserProfileId,
      authorityConnectionIdentity: routeIdentity.authorityConnectionIdentity,
      executionHostIdentity: routeIdentity.executionHostIdentity
    },
    compatibleIdentity: {
      orcaProfileId: routeIdentity.orcaProfileId,
      browserProfileId,
      authorityConnectionIdentity: routeIdentity.pairingAuthorityConnectionIdentity,
      executionHostIdentity: routeIdentity.executionHostIdentity
    },
    legacyIdentity: {
      orcaProfileId: routeIdentity.orcaProfileId,
      browserProfileId,
      authorityConnectionIdentity: routeIdentity.legacyAuthorityConnectionIdentity,
      executionHostIdentity: routeIdentity.legacyExecutionHostIdentity
    },
    storageScope: routeIdentity.storageScope
  })
  const persisted = bindings.get(derived.partition)
  if (persisted === null) {
    bindings.set(
      derived.partition,
      derived.bindingFingerprint,
      routeIdentity.storageScope,
      derived.aliasFingerprint
    )
  } else if (persisted !== derived.bindingFingerprint) {
    throw new Error('browser_route_partition_binding_conflict')
  }
  return derived.partition
}
