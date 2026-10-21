import { session } from 'electron'
import type { BrowserSessionProfile } from '../../shared/browser-workspace-types'
import { isBrowserRoutePartition } from './browser-route-identity'
import {
  clearBrowserSessionPartitionPolicies,
  installBrowserSessionPartitionPolicies
} from './browser-session-partition-policies'

export function installBrowserRoutePartitionPolicies(
  profile: BrowserSessionProfile,
  partition: string,
  { sitePermissions }: { sitePermissions?: 'saved' | 'session' } = {}
): Promise<void> {
  if (!isBrowserRoutePartition(partition)) {
    throw new Error('browser_route_partition_profile_unavailable')
  }
  return installBrowserSessionPartitionPolicies(
    { ...profile, partition },
    { applyAppWideProxy: false, sitePermissions }
  )
}

export function clearBrowserRoutePartitionPolicies(partition: string): void {
  if (!isBrowserRoutePartition(partition)) {
    return
  }
  const sess = session.fromPartition(partition)
  clearBrowserSessionPartitionPolicies(partition, sess)
}
