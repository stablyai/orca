import { boundRoutePartition } from './browser-client-route-cookie-import'
import { forgetClientRouteCookieImportSource } from './client-route-cookie-import-source-store'
import { getPairedRuntimeBrowserClientRouteIdentity } from '../../client-hosts/lifecycle/paired-runtime-browser-client-host-runtime'
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
  const route = { ...routeIdentity, environmentId }
  if (partition === null) {
    await forgetClientRouteCookieImportSource({ route, profileId })
    return true
  }
  return clearRoutePartitionCookies(partition, async () => {
    const current = getPairedRuntimeBrowserClientRouteIdentity(environmentId)
    if (
      !current ||
      current.storageScope !== route.storageScope ||
      current.authorityConnectionIdentity !== route.authorityConnectionIdentity ||
      boundRoutePartition(current, profileId) !== partition
    ) {
      return false
    }
    await forgetClientRouteCookieImportSource({ route, profileId })
    return true
  })
}
