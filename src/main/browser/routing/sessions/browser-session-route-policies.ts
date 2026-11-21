import { session } from 'electron'
import type { BrowserSessionProfile } from '../../../../shared/browser/workspaces/browser-workspace-types'
import { isBrowserRoutePartition } from '../partitions/browser-route-identity'
import {
  clearBrowserSessionPartitionPolicies,
  installBrowserSessionPartitionPolicies
} from '../../sessions/partition-policies/browser-session-partition-policies'
import { restoreBrowserRoutePartitionSessionCookies } from '../../cookies/session-restore/browser-session-cookie-restore'
import { withTimeout } from '../../../../shared/concurrency/promise-timeout-fallback'

// Same bound as launch: a slow restore must not hold the page.
const SESSION_COOKIE_RESTORE_TIMEOUT_MS = 3_000

export async function installBrowserRoutePartitionPolicies(
  profile: BrowserSessionProfile,
  partition: string,
  {
    sitePermissions,
    siteListProfile
  }: { sitePermissions?: 'saved' | 'session'; siteListProfile?: boolean } = {}
): Promise<void> {
  if (!isBrowserRoutePartition(partition)) {
    throw new Error('browser_route_partition_profile_unavailable')
  }
  await Promise.all([
    installBrowserSessionPartitionPolicies(
      { ...profile, partition },
      { applyAppWideProxy: false, fileSystemAccess: false, sitePermissions, siteListProfile }
    ),
    // Why here: SSH and This-device partitions both pass through before their first page loads.
    withTimeout(
      restoreBrowserRoutePartitionSessionCookies(partition),
      SESSION_COOKIE_RESTORE_TIMEOUT_MS,
      undefined
    )
  ])
}

export function clearBrowserRoutePartitionPolicies(partition: string): void {
  if (!isBrowserRoutePartition(partition)) {
    return
  }
  const sess = session.fromPartition(partition)
  clearBrowserSessionPartitionPolicies(partition, sess)
}
