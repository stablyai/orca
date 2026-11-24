import { session } from 'electron'
import { restoreBrowserRoutePartitionSessionCookies } from '../session-restore/browser-session-cookie-route-restore'
import { clearBrowserCookieJar } from '../session-restore/browser-session-cookie-clear'
import { boundLocalSshBrowserPartition } from '../../routing/local-host-partitions/local-ssh-browser-partition-bindings'
import { browserSessionRegistry } from '../../sessions/profiles/browser-session-registry'
import {
  forgetClientRouteCookieImportSource,
  sshCookieImportRoute
} from '../client-route/client-route-cookie-import-source-store'

/** Clears a route jar (SSH or This-device pages) durably; throws when it couldn't. */
export async function clearRoutePartitionCookies(partition: string): Promise<void> {
  // A route jar restores its saved session cookies lazily; a later restore would undo this clear.
  await restoreBrowserRoutePartitionSessionCookies(partition)
  await clearBrowserCookieJar(session.fromPartition(partition))
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
  // Badge first, like the local clear, so quitting mid-clear can't leave "Imported from" behind.
  await forgetClientRouteCookieImportSource({ route: sshCookieImportRoute(targetId), profileId })
  // No page or import has bound this host's jar for the profile: it holds nothing.
  if (partition !== null) {
    await clearRoutePartitionCookies(partition)
  }
  return true
}
