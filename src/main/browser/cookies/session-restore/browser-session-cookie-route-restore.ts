import { isBrowserRoutePartition } from '../../routing/partitions/browser-route-identity'
import { restoreSnapshotTargets } from './browser-session-cookie-restore'
import {
  removeSessionCookieSnapshot,
  routeSnapshotPath,
  snapshotPath
} from './browser-session-cookie-snapshot-file'
import { retireSessionCookieSnapshot } from './browser-session-cookie-tracker'

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

/**
 * For route partition storage being cleared: its saved session cookies go with it, before the jar
 * is. Its restore stays settled until `releaseRetiredRoutePartitions`, after the native wipe and
 * the binding removal, so no page restores (and tracks) the jar while it is still being retired.
 */
export async function forgetBrowserRoutePartitionSessionCookies(partition: string): Promise<void> {
  if (!isBrowserRoutePartition(partition)) {
    return
  }
  const filePath = routeSnapshotPath(partition)
  // One already reading the file (or past its page's timeout) finishes before the file goes.
  const restore = routeRestores.get(filePath)
  routeRestores.set(filePath, restore ?? Promise.resolve())
  await restore
  // File first: any restore that starts from here on reads nothing.
  await retireSessionCookieSnapshot(filePath, removeSessionCookieSnapshot)
}

/** After a route partition's wipe and binding removal: its next page restores and tracks it again. */
export function releaseRetiredRoutePartitions(partitions: readonly string[]): void {
  for (const partition of partitions) {
    if (isBrowserRoutePartition(partition)) {
      routeRestores.delete(routeSnapshotPath(partition))
    }
  }
}

/** For a browser profile being deleted. */
export function forgetBrowserSessionCookies(profileId: string): void {
  try {
    void retireSessionCookieSnapshot(snapshotPath(profileId), removeSessionCookieSnapshot).catch(
      (error: unknown) => warnForgetFailed(profileId, error)
    )
  } catch (error) {
    warnForgetFailed(profileId, error)
  }
}

function warnForgetFailed(label: string, error: unknown): void {
  console.warn('[browser-session-cookies] Could not delete saved cookies for', label, error)
}
