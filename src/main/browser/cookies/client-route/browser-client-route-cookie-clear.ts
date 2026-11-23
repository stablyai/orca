import { session } from 'electron'
import { bindRoutePartition } from './browser-client-route-cookie-import'
import { forgetClientRouteCookieImportSource } from './client-route-cookie-import-source-store'
import { getPairedRuntimeBrowserClientRouteIdentity } from '../../client-hosts/lifecycle/paired-runtime-browser-client-host-runtime'
import { restoreBrowserRoutePartitionSessionCookies } from '../session-restore/browser-session-cookie-restore'
import { clearBrowserCookieJar } from '../session-restore/browser-session-cookie-clear'
import { withCookieImportSourceLock } from '../mutation/cookie-mutation-lock'

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
  const jar = session.fromPartition(partition)
  return withCookieImportSourceLock(jar, async () => {
    const current = getPairedRuntimeBrowserClientRouteIdentity(environmentId)
    if (!current || bindRoutePartition(current, DEFAULT_PROFILE_ID) !== partition) {
      return false
    }
    // A route jar restores its saved session cookies lazily; a later restore would undo this clear.
    await restoreBrowserRoutePartitionSessionCookies(partition)
    await forgetClientRouteCookieImportSource(
      { ...routeIdentity, environmentId },
      DEFAULT_PROFILE_ID
    )
    await clearBrowserCookieJar(jar)
    return true
  })
}
