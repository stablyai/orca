import { browserRouteSessionRegistry } from './browser-route-session-runtime'
import type {
  BrowserSessionProfileSource,
  BrowserCookieImportResult
} from '../../shared/browser-workspace-types'
import {
  detectInstalledBrowsers,
  importCookiesFromBrowser,
  importCookiesFromFile,
  selectBrowserProfile,
  type DetectedBrowser
} from './browser-cookie-import'
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

/**
 * Imports desktop-browser cookies into the client-hosted route partition of a
 * paired server, or null when that server's pages are not client-hosted and the
 * caller should fall through to the server-side import RPC.
 *
 * The renderer names an environment and a browser session profile; main derives
 * and validates the partition, so no caller can address storage directly.
 */
export async function importCookiesIntoClientRoutePartition(
  request: ClientRouteCookieImportRequest
): Promise<BrowserCookieImportResult | null> {
  return runClientRouteCookieImport(request, () => {
    const browser = resolveImportSource(request)
    if ('reason' in browser) {
      return browser
    }
    return {
      importIntoPartition: (partition: string) =>
        importCookiesFromBrowser(browser.source, partition),
      source: {
        browserFamily: browser.source.family,
        profileName: importedProfileName(browser.source)
      }
    }
  })
}

type ClientRouteImportTarget = Pick<
  ClientRouteCookieImportRequest,
  'environmentId' | 'browserProfileId'
>
type ClientRouteImportSource = {
  importIntoPartition: (partition: string) => Promise<BrowserCookieImportResult>
  source: Omit<BrowserSessionProfileSource, 'importedAt'>
}

export async function importCookieFileIntoClientRoutePartition(
  request: ClientRouteImportTarget,
  chooseFile: () => Promise<string | null>
): Promise<BrowserCookieImportResult | null> {
  return runClientRouteCookieImport(request, () => ({
    importIntoPartition: async (partition) => {
      const filePath = await chooseFile()
      if (!filePath) {
        return { ok: false, reason: 'canceled' }
      }
      if (settledRoutePartition(request) !== partition) {
        return {
          ok: false,
          reason: 'The browser connection changed while choosing a cookie file. Try again.'
        }
      }
      return importCookiesFromFile(filePath, partition)
    },
    source: { browserFamily: 'manual' }
  }))
}

async function runClientRouteCookieImport(
  request: ClientRouteImportTarget,
  resolveSource: () => ClientRouteImportSource | { ok: false; reason: string }
): Promise<BrowserCookieImportResult | null> {
  const routeIdentity = getPairedRuntimeBrowserClientRouteIdentity(request.environmentId)
  if (!routeIdentity) {
    return null
  }
  const source = resolveSource()
  if ('reason' in source) {
    return source
  }
  let partition: string
  try {
    partition = bindRoutePartition(routeIdentity, request.browserProfileId)
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
  const result = await source.importIntoPartition(partition)
  if (!result.ok && result.reason === 'canceled') {
    return result
  }
  // Why: the import runs for seconds. A host replacement inside that window retargets the
  // route, so reporting success here would badge a partition no page will ever read from.
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
  // Why: per-environment, not the local registry — the badge must describe the jar
  // that received the cookies (this desktop's route partition for THIS server),
  // never the local profile jar the import deliberately bypassed.
  recordClientRouteCookieImportSource({
    environmentId: request.environmentId,
    profileId: request.browserProfileId,
    source: {
      ...source.source,
      importedAt: Date.now()
    }
  })
  return { ...result, profileId: request.browserProfileId }
}

/** Partition the route resolves to now, or null when the host no longer serves this environment. */
function settledRoutePartition(request: ClientRouteImportTarget): string | null {
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

function bindRoutePartition(
  routeIdentity: NonNullable<ReturnType<typeof getPairedRuntimeBrowserClientRouteIdentity>>,
  browserProfileId: string
): string {
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
  // An active route already validated the host-owned profile when its guest was prepared.
  if (!browserRouteSessionRegistry.isAllowedPartition(derived.partition)) {
    browserSessionRegistry.requireRouteBrowserProfile(browserProfileId)
    if (!browserSessionRegistry.getProfile(browserProfileId)) {
      throw new Error('Session profile not found.')
    }
  }
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
  // Why: browserProfile reaches a filesystem path, so reject traversal before use.
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
