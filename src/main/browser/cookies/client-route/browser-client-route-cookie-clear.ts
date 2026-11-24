import { session } from 'electron'
import { bindRoutePartition } from './browser-client-route-cookie-import'
import { forgetClientRouteCookieImportSource } from './client-route-cookie-import-source-store'
import { getPairedRuntimeBrowserClientRouteIdentity } from '../../client-hosts/lifecycle/paired-runtime-browser-client-host-runtime'
import { restoreBrowserRoutePartitionSessionCookies } from '../session-restore/browser-session-cookie-route-restore'
import { clearBrowserCookieJar } from '../session-restore/browser-session-cookie-clear'

const DEFAULT_PROFILE_ID = 'default'

/** Clears the Default jar Settings import fills for a server's This-device pages; null when this desktop doesn't host them. */
export async function clearClientRouteDefaultCookies(
  environmentId: string
): Promise<boolean | null> {
  const routeIdentity = getPairedRuntimeBrowserClientRouteIdentity(environmentId)
  if (!routeIdentity) {
    return null
  }
  const partition = bindRoutePartition(routeIdentity, DEFAULT_PROFILE_ID)
  // Badge first, like the local clear, so quitting mid-clear can't leave "Imported from" behind.
  await forgetClientRouteCookieImportSource({ environmentId, profileId: DEFAULT_PROFILE_ID })
  // A route jar restores its saved session cookies lazily; a later restore would undo this clear.
  await restoreBrowserRoutePartitionSessionCookies(partition)
  await clearBrowserCookieJar(session.fromPartition(partition))
  return true
}
