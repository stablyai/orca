import type {
  BrowserCookieImportResult,
  BrowserCookieImportSelection,
  BrowserSessionProfileSource
} from '../../../../shared/browser/workspaces/browser-workspace-types'
import {
  browserCookieImportFailure,
  type BrowserCookieImportFailure
} from '../../../../shared/browser/cookies/browser-cookie-import-failure-copy'
import { importedBrowserProfileSource } from '../sources/browser-cookie-source-profiles'
import {
  detectInstalledBrowsers,
  resolveBrowserImportSelection,
  selectBrowserProfile
} from '../sources/browser-cookie-detection'
import { importCookiesFromBrowser } from '../browser-cookie-import'
import { importCookiesFromFile } from '../imports/import-cookie-file'

import {
  clientRouteCookieImportSources,
  recordClientRouteCookieImportSource
} from './client-route-cookie-import-source-store'
import { restoreBrowserRoutePartitionSessionCookies } from '../session-restore/browser-session-cookie-restore'
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

type ClientRouteCookieSource = {
  importInto: (partition: string) => Promise<BrowserCookieImportResult>
  importedSource: () => BrowserSessionProfileSource
}

/** Main derives the destination partition; null delegates to the server-side import RPC. */
export async function importCookiesIntoClientRoutePartition(
  request: ClientRouteCookieImportRequest
): Promise<BrowserCookieImportResult | null> {
  return importIntoClientRoutePartition(request, async (authority) => {
    const previous =
      'refreshSourceId' in request
        ? clientRouteCookieImportSources(request.environmentId, authority)[request.browserProfileId]
        : null
    const selection = resolveBrowserImportSelection(request, previous)
    if ('reason' in selection) {
      return selection
    }
    const [detected] = detectInstalledBrowsers(selection.browserFamily)
    const browser = selectBrowserProfile(detected, selection)
    if ('reason' in browser) {
      return browser
    }
    return {
      importInto: (partition) => importCookiesFromBrowser(browser, partition),
      importedSource: () => importedBrowserProfileSource(browser)
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
      importedSource: () => ({ browserFamily: 'manual', importedAt: Date.now() })
    }
  })
}

async function importIntoClientRoutePartition(
  target: ClientRouteCookieImportTarget,
  resolveSource: (
    authority: string
  ) => Promise<ClientRouteCookieSource | BrowserCookieImportFailure>
): Promise<BrowserCookieImportResult | null> {
  const routeIdentity = getPairedRuntimeBrowserClientRouteIdentity(target.environmentId)
  if (!routeIdentity) {
    return null
  }
  const profile = browserSessionRegistry.getProfile(target.browserProfileId)
  if (!profile) {
    return browserCookieImportFailure('profileNotFound')
  }
  const source = await resolveSource(routeIdentity.authorityConnectionIdentity)
  if ('reason' in source) {
    return source
  }
  let partition: string
  try {
    partition = bindRoutePartition(routeIdentity, target.browserProfileId)
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
  // Saved session cookies go back first, or the next page's restore would overwrite the import.
  await restoreBrowserRoutePartitionSessionCookies(partition)
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
    authority: routeIdentity.authorityConnectionIdentity,
    source: source.importedSource()
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
