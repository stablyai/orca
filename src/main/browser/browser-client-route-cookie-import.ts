import type {
  BrowserCookieImportResult,
  BrowserSessionProfileSource
} from '../../shared/browser-workspace-types'
import {
  browserCookieImportFailure,
  type BrowserCookieImportFailure
} from '../../shared/browser-cookie-import-failure-copy'
import {
  detectInstalledBrowsers,
  importCookiesFromBrowser,
  importCookiesFromFile,
  selectBrowserProfile
} from './cookies/browser-cookie-import'
import type { DetectedBrowser } from './cookies/sources/browser-cookie-detection-types'

import { recordClientRouteCookieImportSource } from './client-route-cookie-import-source-store'
import { currentBrowserRoutePartitionBindingStore } from './browser-route-partition-binding-runtime'
import { resolveBrowserRoutePartitionBinding } from './browser-route-partition-migration'
import { browserSessionRegistry } from './browser-session-registry'
import { getPairedRuntimeBrowserClientRouteIdentity } from './paired-runtime-browser-client-host-runtime'

type ClientRouteCookieImportTarget = {
  environmentId: string
  browserProfileId: string
}

export type ClientRouteCookieImportRequest = ClientRouteCookieImportTarget & {
  browserFamily: string
  browserProfile?: string
}

type ClientRouteCookieSource = {
  importInto: (partition: string) => Promise<BrowserCookieImportResult>
  badge: Omit<BrowserSessionProfileSource, 'importedAt'>
}

/** Main derives the destination partition; null delegates to the server-side import RPC. */
export async function importCookiesIntoClientRoutePartition(
  request: ClientRouteCookieImportRequest
): Promise<BrowserCookieImportResult | null> {
  return importIntoClientRoutePartition(request, async () => {
    const browser = resolveImportSource(request)
    if ('reason' in browser) {
      return browser
    }
    return {
      importInto: (partition) => importCookiesFromBrowser(browser.source, partition),
      badge: {
        browserFamily: browser.source.family,
        profileName: importedProfileName(browser.source)
      }
    }
  })
}

/** Null when this desktop does not host the environment's pages; a remote file is never read. */
export async function importCookieFileIntoClientRoutePartition(
  target: ClientRouteCookieImportTarget,
  pickFile: () => Promise<string | null>
): Promise<BrowserCookieImportResult | null> {
  return importIntoClientRoutePartition(target, async () => {
    const filePath = await pickFile()
    if (!filePath) {
      return { ok: false, reason: 'canceled' }
    }
    return {
      importInto: (partition) => importCookiesFromFile(filePath, partition),
      badge: { browserFamily: 'manual' }
    }
  })
}

async function importIntoClientRoutePartition(
  target: ClientRouteCookieImportTarget,
  resolveSource: () => Promise<ClientRouteCookieSource | BrowserCookieImportFailure>
): Promise<BrowserCookieImportResult | null> {
  const routeIdentity = getPairedRuntimeBrowserClientRouteIdentity(target.environmentId)
  if (!routeIdentity) {
    return null
  }
  const profile = browserSessionRegistry.getProfile(target.browserProfileId)
  if (!profile) {
    return browserCookieImportFailure('profileNotFound')
  }
  const source = await resolveSource()
  if ('reason' in source) {
    return source
  }
  let partition: string
  try {
    partition = bindRoutePartition(routeIdentity, target.browserProfileId)
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
  const result = await source.importInto(partition)
  // Re-pairing while picking or importing changes the destination; reject a stale success.
  const settled = settledRoutePartition(target)
  if (settled !== partition) {
    return browserCookieImportFailure(settled === null ? 'connectionEnded' : 'serverRepaired')
  }
  if (!result.ok) {
    return result
  }
  // Badge this desktop’s server-route jar, rather than the local profile jar.
  recordClientRouteCookieImportSource({
    environmentId: target.environmentId,
    profileId: target.browserProfileId,
    source: { ...source.badge, importedAt: Date.now() }
  })
  return {
    ...result,
    profileId: target.browserProfileId,
    googleCookieClearTarget: {
      label: profile.label,
      local: {
        profileId: profile.id,
        environmentId: target.environmentId,
        partition,
        routeIdentity: JSON.stringify(routeIdentity)
      }
    }
  }
}

function settledRoutePartition(target: ClientRouteCookieImportTarget): string | null {
  const routeIdentity = getPairedRuntimeBrowserClientRouteIdentity(target.environmentId)
  if (!routeIdentity) {
    return null
  }
  try {
    return bindRoutePartition(routeIdentity, target.browserProfileId)
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
): { source: DetectedBrowser } | BrowserCookieImportFailure {
  // Profile names become filesystem path segments.
  if (
    request.browserProfile &&
    (/[/\\]/.test(request.browserProfile) || request.browserProfile.includes('..'))
  ) {
    return browserCookieImportFailure('invalidBrowserProfile')
  }
  const browser = detectInstalledBrowsers().find((entry) => entry.family === request.browserFamily)
  if (!browser) {
    return browserCookieImportFailure('browserNotFound')
  }
  if (!request.browserProfile || request.browserProfile === browser.selectedProfile) {
    return { source: browser }
  }
  const reselected = selectBrowserProfile(browser, request.browserProfile)
  if (!reselected) {
    return browserCookieImportFailure('browserProfileDatabaseMissing', {
      profile: request.browserProfile
    })
  }
  return { source: reselected }
}

function importedProfileName(browser: DetectedBrowser): string {
  return (
    browser.profiles.find((entry) => entry.directory === browser.selectedProfile)?.name ??
    browser.selectedProfile
  )
}
