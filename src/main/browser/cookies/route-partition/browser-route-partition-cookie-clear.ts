import { restoreBrowserRoutePartitionSessionCookies } from '../session-restore/browser-session-cookie-route-restore'
import { clearBrowserCookieJarWithSource } from '../session-restore/browser-session-cookie-clear'
import { boundLocalSshBrowserPartition } from '../../routing/local-host-partitions/local-ssh-browser-partition-bindings'
import { browserSessionRegistry } from '../../sessions/profiles/browser-session-registry'
import {
  forgetClientRouteCookieImportSource,
  sshCookieImportRoute
} from '../client-route/client-route-cookie-import-source-store'

/** Clears a route jar after checking its binding and clearing its source. */
export function clearRoutePartitionCookies(
  partition: string,
  clearSource: () => Promise<boolean>
): Promise<boolean> {
  return clearBrowserCookieJarWithSource(partition, async () => {
    if (!(await clearSource())) {
      return false
    }
    // A route jar restores its saved session cookies lazily; a later restore would undo this clear.
    await restoreBrowserRoutePartitionSessionCookies(partition)
    return true
  })
}

/** Clears the jar this SSH host's pages of one local profile use, on this computer. */
export async function clearSshRouteProfileCookies(
  targetId: string,
  profileId: string
): Promise<boolean> {
  if (!browserSessionRegistry.getProfile(profileId)) {
    return false
  }
  // Read before the badge goes, so a binding conflict fails with the badge still telling the truth.
  const partition = boundLocalSshBrowserPartition(targetId, profileId)
  const forgetSource = () =>
    forgetClientRouteCookieImportSource({ route: sshCookieImportRoute(targetId), profileId })
  // No page or import has bound this host's jar for the profile: it holds nothing.
  if (partition === null) {
    await forgetSource()
    return true
  }
  return clearRoutePartitionCookies(partition, async () => {
    if (boundLocalSshBrowserPartition(targetId, profileId) !== partition) {
      return false
    }
    await forgetSource()
    return true
  })
}
