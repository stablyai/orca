import { isBrowserRoutePartition } from '../../routing/partitions/browser-route-identity'
import { restoreSnapshotTargets } from './browser-session-cookie-restore'
import {
  removeSessionCookieSnapshot,
  routeSnapshotPath
} from './browser-session-cookie-snapshot-file'
import { stopTrackingSessionCookies } from './browser-session-cookie-tracker'

const routeRestores = new Map<string, Promise<void>>()

/**
 * SSH and This-device pages open their route partition on demand, so its saved session cookies
 * go back before its first page loads. Once per launch: later pages share the live jar.
 */
export async function restoreBrowserRoutePartitionSessionCookies(partition: string): Promise<void> {
  const filePath = routeSnapshotPath(partition)
  let restore = routeRestores.get(filePath)
  if (!restore) {
    // Never rejects: a jar that can't be restored still opens, signed out.
    restore = restoreSnapshotTargets([{ label: 'route partition', filePath, partition }]).catch(
      (error: unknown) =>
        console.warn('[browser-session-cookies] Route partition restore failed:', error)
    )
    routeRestores.set(filePath, restore)
  }
  return restore
}

/** For route partition storage being cleared: its saved session cookies go with it, before the jar is. */
export async function forgetBrowserRoutePartitionSessionCookies(partition: string): Promise<void> {
  if (!isBrowserRoutePartition(partition)) {
    return
  }
  const filePath = routeSnapshotPath(partition)
  stopTrackingSessionCookies(filePath)
  try {
    // File first: any restore that starts from here on reads nothing.
    await removeSessionCookieSnapshot(filePath)
  } finally {
    // One that read it already (or ran past its page's timeout) finishes before the jar is cleared,
    // and the next restore tracks the jar again even when the file could not go.
    const restore = routeRestores.get(filePath)
    await restore
    // Only after it settles, so an overlapping retirement waits for the same restore.
    if (routeRestores.get(filePath) === restore) {
      routeRestores.delete(filePath)
    }
  }
}
