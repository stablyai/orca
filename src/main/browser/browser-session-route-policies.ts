import { session } from 'electron'
import type { BrowserSessionProfile } from '../../shared/browser-workspace-types'
import { isBrowserRoutePartition } from './browser-route-identity'
import {
  clearBrowserSessionPartitionPolicies,
  installBrowserSessionPartitionPolicies
} from './browser-session-partition-policies'
import { clearBrowserSessionUserAgentMode } from './browser-session-user-agent-mode'

export function installBrowserRoutePartitionPolicies(
  profile: BrowserSessionProfile,
  partition: string
): void {
  if (!isBrowserRoutePartition(partition)) {
    throw new Error('browser_route_partition_profile_unavailable')
  }
  void installBrowserSessionPartitionPolicies(
    { ...profile, partition },
    { applyAppWideProxy: false }
  )
}

export function clearBrowserRoutePartitionPolicies(partition: string): void {
  if (!isBrowserRoutePartition(partition)) {
    return
  }
  const sess = session.fromPartition(partition)
  clearBrowserSessionUserAgentMode(sess)
  clearBrowserSessionPartitionPolicies(partition, sess)
}
