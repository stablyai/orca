import type { InstalledBrowserExtension } from '../../../../shared/browser/extensions/browser-extension-types'
import type { BrowserSessionProfile } from '../../../../shared/browser/workspaces/browser-workspace-types'
import { isBrowserRoutePartition } from '../../routing/partitions/browser-route-identity'
import {
  detachBrowserExtensionsFromProfileSession,
  getBrowserExtensionSessionForProfile,
  loadBrowserExtensionIntoProfile,
  unloadBrowserExtensionFromProfile
} from './browser-extension-session-loader'

/**
 * An SSH or This-device page's session runs its local profile's extensions as a separate
 * instance, since its network goes through the remote host. Its own id keys that instance's
 * state; enablement and pins stay the local profile's.
 */
type BrowserExtensionRouteProfile = Readonly<{
  /** Its local profile, re-keyed to this session: the profile the extension loader runs. */
  profile: BrowserSessionProfile
  sourceProfileId: string
}>

const ROUTE_PROFILE_PREFIX = 'route-'
const routeProfilesById = new Map<string, BrowserExtensionRouteProfile>()

/** Stable across restarts, so the instance keeps its saved state with its partition's storage. */
export function browserExtensionRouteProfileId(partition: string): string {
  if (!isBrowserRoutePartition(partition)) {
    throw new Error('browser_extension_route_partition_invalid')
  }
  return `${ROUTE_PROFILE_PREFIX}${partition.slice(partition.lastIndexOf('-') + 1)}`
}

export function linkBrowserExtensionRouteProfile(
  partition: string,
  source: BrowserSessionProfile
): string {
  const id = browserExtensionRouteProfileId(partition)
  routeProfilesById.set(id, {
    profile: { ...source, id, partition, source: null },
    sourceProfileId: source.id
  })
  return id
}

export function browserExtensionRouteSessionProfile(
  profileId: string
): BrowserSessionProfile | null {
  return routeProfilesById.get(profileId)?.profile ?? null
}

/** Before a remote page's storage is wiped: stop its extensions and forget their saved state. */
export async function retireBrowserExtensionRouteProfile(partition: string): Promise<void> {
  const profileId = browserExtensionRouteProfileId(partition)
  const route = routeProfilesById.get(profileId)
  // Why only linked: a session that never ran extensions this launch has none running to stop.
  if (route) {
    routeProfilesById.delete(profileId)
    await detachBrowserExtensionsFromProfileSession(route.profile)
  }
}

/** The local profile whose enabled list and pins apply; itself for a local profile. */
export function browserExtensionSourceProfileId(profileId: string): string {
  return routeProfilesById.get(profileId)?.sourceProfileId ?? profileId
}

export function listBrowserExtensionRouteProfileIds(): string[] {
  return [...routeProfilesById.keys()]
}

/**
 * Turning one on in a profile also starts it wherever that profile runs and doesn't have it yet:
 * the profile itself, and its SSH and This-device pages. Idle ones load it when they reopen.
 */
export async function loadBrowserExtensionWhereProfileRuns(
  sourceProfileId: string,
  extension: InstalledBrowserExtension
): Promise<void> {
  const profileIds = [sourceProfileId, ...routeProfileIdsOf(sourceProfileId)].filter(
    (profileId) => {
      const sess = getBrowserExtensionSessionForProfile(profileId)
      return sess !== null && !sess.extensions.getExtension(extension.id)
    }
  )
  await Promise.all(
    profileIds.map((profileId) =>
      loadBrowserExtensionIntoProfile(profileId, extension).catch((error: unknown) => {
        // Why not thrown: the caller's own load succeeded; another page's instance must not undo it.
        console.warn(`[browser-extensions] Could not start ${extension.id} in ${profileId}:`, error)
      })
    )
  )
}

export function unloadBrowserExtensionFromRouteProfilesOf(
  sourceProfileId: string,
  extensionId: string
): void {
  for (const profileId of routeProfileIdsOf(sourceProfileId)) {
    unloadBrowserExtensionFromProfile(profileId, extensionId)
  }
}

function routeProfileIdsOf(sourceProfileId: string): string[] {
  return [...routeProfilesById]
    .filter(([, route]) => route.sourceProfileId === sourceProfileId)
    .map(([profileId]) => profileId)
}
