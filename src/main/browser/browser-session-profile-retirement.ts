import type { Session } from 'electron'
import { retireProxySessionApplication } from '../network/proxy-settings'
import { clearBrowserSessionPartitionPolicies } from './browser-session-partition-policies'

export async function retireFailedBrowserSessionProfile(
  partition: string,
  sess: Session
): Promise<void> {
  const retirement = retireProxySessionApplication(sess)
  try {
    clearBrowserSessionPartitionPolicies(partition, sess)
  } catch {
    // Best-effort policy cleanup must not skip retirement.
  }
  try {
    await retirement
  } catch {
    console.warn('[proxy] Failed to release proxy from browser partition', partition)
  }
}
