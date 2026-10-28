import { session, type Session } from 'electron'
import type { BrowserSessionProfile } from '../../shared/browser-workspace-types'
import { retireProxySessionApplication } from '../network/proxy-settings'
import {
  clearBrowserSessionPartitionPolicies,
  forgetBrowserSessionPartitionConfiguration,
  retireBrowserSessionUserAgentPolicy
} from './browser-session-partition-policies'
import { invalidateBrowserSessionProxyApplication } from './browser-session-proxy'
import { cancelBrowserWebAuthnAccountRequestsForSession } from './browser-webauthn-account-picker'
import { detachBrowserExtensionsFromProfileSession } from './extensions/browser-extension-session-loader'

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

/** Profile delete, after the registry has dropped it: unload extensions and clear its storage. */
export async function retireDeletedBrowserSessionProfile(
  profile: BrowserSessionProfile
): Promise<void> {
  await detachBrowserExtensionsFromProfileSession(profile)
  // Why: clear the partition's storage so deleting a profile doesn't leave orphaned cookies/cache behind.
  try {
    const sess = session.fromPartition(profile.partition)
    forgetBrowserSessionPartitionConfiguration(profile.partition)
    retireBrowserSessionUserAgentPolicy(sess)
    invalidateBrowserSessionProxyApplication(sess)
    const release = retireProxySessionApplication(sess)
    // Why: persistent partitions can retain service workers after every WebContents dies, so a retired session's deny policies must remain permanent.
    cancelBrowserWebAuthnAccountRequestsForSession(sess)
    try {
      await release
    } catch {
      console.warn('[proxy] Failed to release proxy from browser partition', profile.partition)
    }
    await sess.clearStorageData()
    await sess.clearCache()
  } catch {
    // Why: cleanup is best-effort — the profile is already out of the registry, so will-attach-webview blocks it regardless.
  }
}
