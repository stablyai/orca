import type { BrowserCookieImportResult } from '../../shared/browser-workspace-types'
import {
  detectInstalledBrowsers,
  importCookiesFromBrowser,
  selectBrowserProfile
} from './cookies/browser-cookie-import'
import type { DetectedBrowser } from './cookies/sources/browser-cookie-detection-types'

import { recordClientRouteCookieImportSource } from './client-route-cookie-import-source-store'
import { currentBrowserRoutePartitionBindingStore } from './browser-route-partition-binding-runtime'
import { resolveBrowserRoutePartitionBinding } from './browser-route-partition-migration'
import { browserSessionRegistry } from './browser-session-registry'
import { getPairedRuntimeBrowserClientRouteIdentity } from './paired-runtime-browser-client-host-runtime'

export type ClientRouteCookieImportRequest = {
  environmentId: string
  browserProfileId: string
  browserFamily: string
  browserProfile?: string
}

/** Main derives the destination partition; null delegates to the server-side import RPC. */
export async function importCookiesIntoClientRoutePartition(
  request: ClientRouteCookieImportRequest
): Promise<BrowserCookieImportResult | null> {
  const routeIdentity = getPairedRuntimeBrowserClientRouteIdentity(request.environmentId)
  if (!routeIdentity) {
    return null
  }
  const profile = browserSessionRegistry.getProfile(request.browserProfileId)
  if (!profile) {
    return { ok: false, reason: 'Session profile not found.' }
  }
  const browser = resolveImportSource(request)
  if ('reason' in browser) {
    return browser
  }
  let partition: string
  try {
    partition = bindRoutePartition(routeIdentity, request.browserProfileId)
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
  const result = await importCookiesFromBrowser(browser.source, partition)
  // Re-pairing during import can change the destination; reject a stale success.
  const settled = settledRoutePartition(request)
  if (settled !== partition) {
    return {
      ok: false,
      reason:
        settled === null
          ? 'The connection to this server ended during the import. Reconnect and try again.'
          : 'This server was re-paired during the import. Try again.'
    }
  }
  if (!result.ok) {
    return result
  }
  // Badge this desktop’s server-route jar, rather than the local profile jar.
  recordClientRouteCookieImportSource({
    environmentId: request.environmentId,
    profileId: request.browserProfileId,
    source: {
      browserFamily: browser.source.family,
      profileName: importedProfileName(browser.source),
      importedAt: Date.now()
    }
  })
  return {
    ...result,
    profileId: request.browserProfileId,
    googleCookieClearTarget: {
      label: profile.label,
      local: {
        profileId: profile.id,
        environmentId: request.environmentId,
        partition,
        routeIdentity: JSON.stringify(routeIdentity)
      }
    }
  }
}

function settledRoutePartition(request: ClientRouteCookieImportRequest): string | null {
  const routeIdentity = getPairedRuntimeBrowserClientRouteIdentity(request.environmentId)
  if (!routeIdentity) {
    return null
  }
  try {
    return bindRoutePartition(routeIdentity, request.browserProfileId)
  } catch {
    return null
  }
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

function resolveImportSource(
  request: ClientRouteCookieImportRequest
): { source: DetectedBrowser } | { ok: false; reason: string } {
  // Profile names become filesystem path segments.
  if (
    request.browserProfile &&
    (/[/\\]/.test(request.browserProfile) || request.browserProfile.includes('..'))
  ) {
    return { ok: false, reason: 'Invalid browser profile name.' }
  }
  const browser = detectInstalledBrowsers().find((entry) => entry.family === request.browserFamily)
  if (!browser) {
    return { ok: false, reason: 'Browser not found on this system.' }
  }
  if (!request.browserProfile || request.browserProfile === browser.selectedProfile) {
    return { source: browser }
  }
  const reselected = selectBrowserProfile(browser, request.browserProfile)
  if (!reselected) {
    return {
      ok: false,
      reason: `No cookies database found for profile "${request.browserProfile}".`
    }
  }
  return { source: reselected }
}

function importedProfileName(browser: DetectedBrowser): string {
  return (
    browser.profiles.find((entry) => entry.directory === browser.selectedProfile)?.name ??
    browser.selectedProfile
  )
}
