import type { BrowserCookieImportResult } from '../../../../shared/browser/workspaces/browser-workspace-types'
import {
  browserCookieImportFailure,
  type BrowserCookieImportFailure
} from '../../../../shared/browser/cookies/browser-cookie-import-failure-copy'
import { recordClientRouteCookieImportSource } from './client-route-cookie-import-source-store'
import {
  browserCookieImportSource,
  cookieFileImportSource,
  importIntoRoutePartition,
  type RouteCookieImportSource
} from '../route-partition/browser-route-partition-cookie-import'
import { currentBrowserRoutePartitionBindingStore } from '../../routing/partitions/browser-route-partition-binding-runtime'
import { resolveBrowserRoutePartitionBinding } from '../../routing/partitions/browser-route-partition-migration'
import { browserSessionRegistry } from '../../sessions/profiles/browser-session-registry'
import { validateBrowserRouteProfile } from '../../routing/sessions/browser-route-profile-validation'
import { BrowserClientProfileMetadata } from '../../../../shared/browser/client-hosting/browser-client-profile-switch-protocol'
import { getPairedRuntimeBrowserClientRouteIdentity } from '../../client-hosts/lifecycle/paired-runtime-browser-client-host-state'
import { browserClientPageCookieJar } from '../../client-pages/lifecycle/browser-client-page-cookie-jars'

type ClientRouteCookieImportTarget = {
  environmentId: string
  browserProfileId: string
  /** The server's metadata for its profile, whose id names no profile on this desktop. */
  profile?: unknown
  /** Fill this page's own jar (its profile and network host), not the profile's server jar. */
  browserPageId?: string
}

export type ClientRouteCookieImportRequest = ClientRouteCookieImportTarget & {
  browserFamily: string
  browserProfile?: string
}

/** Main derives the destination partition; null delegates to the server-side import RPC. */
export async function importCookiesIntoClientRoutePartition(
  request: ClientRouteCookieImportRequest
): Promise<BrowserCookieImportResult | null> {
  return importIntoClientRoutePartition(request, async () => browserCookieImportSource(request))
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
  resolveSource: () => Promise<RouteCookieImportSource | BrowserCookieImportFailure>
): Promise<BrowserCookieImportResult | null> {
  const routeIdentity = getPairedRuntimeBrowserClientRouteIdentity(target.environmentId)
  if (!routeIdentity) {
    // A page's import never falls back to the server's own store.
    return target.browserPageId === undefined ? null : browserCookieImportFailure('connectionEnded')
  }
  const destination =
    target.browserPageId === undefined
      ? profileJarDestination(routeIdentity, target)
      : pageJarDestination(routeIdentity, target.environmentId, target.browserPageId)
  if ('reason' in destination) {
    return destination
  }
  const imported = await importIntoRoutePartition(destination, resolveSource)
  if (!imported.ok) {
    return imported
  }
  if (destination.isProfileJar(imported.partition)) {
    // Badge this desktop’s server-route jar, rather than the local profile jar.
    await recordClientRouteCookieImportSource({
      route: target.environmentId,
      profileId: destination.profileId,
      source: { ...imported.source.badge, importedAt: Date.now() }
    })
  }
  const result = { ...imported.result, profileId: destination.profileId }
  return destination.label === null
    ? result
    : {
        ...result,
        googleCookieClearTarget: {
          label: destination.label,
          local: {
            profileId: destination.profileId,
            environmentId: target.environmentId,
            partition: imported.partition,
            routeIdentity: JSON.stringify(routeIdentity)
          }
        }
      }
}

type ClientRouteJarDestination = Parameters<typeof importIntoRoutePartition>[0] & {
  profileId: string
  /** True when the filled jar is the one the profile's Settings badge describes. */
  isProfileJar: (partition: string) => boolean
  /** Null for a page's jar, which the Google cookie clear can't re-derive. */
  label: string | null
}

function profileJarDestination(
  routeIdentity: ClientRouteIdentity,
  target: ClientRouteCookieImportTarget
): ClientRouteJarDestination | BrowserCookieImportFailure {
  let label: string
  try {
    validateBrowserRouteProfile(target.browserProfileId, target.profile)
    label = profileLabel(target)
  } catch {
    return browserCookieImportFailure('profileNotFound')
  }
  return {
    // Bound to the pairing the request saw; a re-pair while picking must not redirect it.
    bindPartition: () => bindRoutePartition(routeIdentity, target.browserProfileId, target.profile),
    currentPartition: () => settledRoutePartition(target),
    // Re-pairing while picking or importing changes the destination; reject a stale success.
    routeChanged: (settled) =>
      browserCookieImportFailure(settled === null ? 'connectionEnded' : 'serverRepaired'),
    profileId: target.browserProfileId,
    isProfileJar: () => true,
    label
  }
}

/** Pages on an SSH host or WSL distro behind the server keep their own jar; only the page knows it. */
function pageJarDestination(
  routeIdentity: ClientRouteIdentity,
  environmentId: string,
  browserPageId: string
): ClientRouteJarDestination | BrowserCookieImportFailure {
  const jar = browserClientPageCookieJar(environmentId, browserPageId)
  if (!jar) {
    return browserCookieImportFailure('pageChanged')
  }
  const currentPartition = (): string | null =>
    browserClientPageCookieJar(environmentId, browserPageId)?.partition ?? null
  return {
    // Pinned to the jar the request saw: a switch while the picker is open must not redirect it.
    bindPartition: () => (currentPartition() === jar.partition ? jar.partition : null),
    currentPartition,
    // A closed page or a profile switch would make success describe another jar.
    routeChanged: () => browserCookieImportFailure('pageChanged'),
    profileId: jar.browserProfileId,
    isProfileJar: (partition) =>
      deriveRoutePartition(routeIdentity, jar.browserProfileId).partition === partition,
    label: null
  }
}

function profileLabel(target: ClientRouteCookieImportTarget): string {
  if (target.profile) {
    return BrowserClientProfileMetadata.parse(target.profile).label
  }
  const profile = browserSessionRegistry.getProfile(target.browserProfileId)
  if (!profile) {
    throw new Error('browser_route_partition_profile_unavailable')
  }
  return profile.label
}

function settledRoutePartition(target: ClientRouteCookieImportTarget): string | null {
  const routeIdentity = getPairedRuntimeBrowserClientRouteIdentity(target.environmentId)
  return routeIdentity
    ? bindRoutePartition(routeIdentity, target.browserProfileId, target.profile)
    : null
}

type ClientRouteIdentity = NonNullable<
  ReturnType<typeof getPairedRuntimeBrowserClientRouteIdentity>
>

function deriveRoutePartition(
  routeIdentity: ClientRouteIdentity,
  browserProfileId: string,
  bindings = currentBrowserRoutePartitionBindingStore()
): ReturnType<typeof resolveBrowserRoutePartitionBinding> {
  return resolveBrowserRoutePartitionBinding({
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
}

/** The jar a page or import already bound for this profile on the route; null when none has. Never creates a binding; it migrates an older build's one the same way import does. */
export function boundRoutePartition(
  routeIdentity: ClientRouteIdentity,
  browserProfileId: string
): string | null {
  const bindings = currentBrowserRoutePartitionBindingStore()
  const derived = deriveRoutePartition(routeIdentity, browserProfileId, bindings)
  const persisted = bindings.get(derived.partition)
  if (persisted === null) {
    return null
  }
  if (persisted !== derived.bindingFingerprint) {
    throw new Error('browser_route_partition_binding_conflict')
  }
  return derived.partition
}

export function bindRoutePartition(
  routeIdentity: ClientRouteIdentity,
  browserProfileId: string,
  profile?: unknown
): string {
  validateBrowserRouteProfile(browserProfileId, profile)
  const bindings = currentBrowserRoutePartitionBindingStore()
  const derived = deriveRoutePartition(routeIdentity, browserProfileId, bindings)
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
