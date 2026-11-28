import { boundRoutePartition } from './browser-client-route-cookie-import'
import { forgetClientRouteCookieImportSource } from './client-route-cookie-import-source-store'
import { getPairedRuntimeBrowserClientRouteIdentity } from '../../client-hosts/lifecycle/paired-runtime-browser-client-host-state'
import { clearRoutePartitionCookies } from '../route-partition/browser-route-partition-cookie-clear'

/** Clears the jar a server profile's This-device pages use on this desktop; null when this desktop doesn't host them. */
export async function clearClientRouteProfileCookies(
  environmentId: string,
  profileId: string
): Promise<boolean | null> {
  const routeIdentity = getPairedRuntimeBrowserClientRouteIdentity(environmentId)
  if (!routeIdentity) {
    return null
  }
  const partition = boundRoutePartition(routeIdentity, profileId)
  // Badge first, like the local clear, so quitting mid-clear can't leave "Imported from" behind.
  await forgetClientRouteCookieImportSource({ route: environmentId, profileId })
  // No page or import has bound this profile's jar: it holds nothing.
  if (partition !== null) {
    await clearRoutePartitionCookies(partition)
  }
  return true
}
