import { session, type Session } from 'electron'
import type { BrowserSessionProfile } from '../../shared/browser-workspace-types'
import { applyProxySettingsToSession } from '../network/proxy-settings'
import type { NetworkProxySettings } from '../../shared/network-proxy'

// Why: browser modules hold no store handle, so main injects a reader the way rate-limits does.
let resolveNetworkProxySettings: (() => NetworkProxySettings) | null = null
let proxyPolicyGeneration = 0
// Why: removed partitions must stop stale readiness loops before their queued system release.
const browserSessionProxyApplicationGenerations = new WeakMap<Session, number>()

export function setBrowserNetworkProxySettingsResolver(
  resolver: (() => NetworkProxySettings) | null
): void {
  resolveNetworkProxySettings = resolver
  if (!resolver) {
    proxyPolicyGeneration = 0
  }
}

export async function applyProxyToBrowserSession(sess: Session): Promise<void> {
  const applicationGeneration = browserSessionProxyApplicationGenerations.get(sess) ?? 0
  let observedGeneration: number
  do {
    observedGeneration = proxyPolicyGeneration
    const resolved = resolveNetworkProxySettings?.()
    if (!resolved) {
      return
    }
    await applyProxySettingsToSession(sess, resolved)
  } while (
    applicationGeneration === (browserSessionProxyApplicationGenerations.get(sess) ?? 0) &&
    observedGeneration !== proxyPolicyGeneration
  )
}

export function invalidateBrowserSessionProxyApplication(sess: Session): void {
  const generation = browserSessionProxyApplicationGenerations.get(sess) ?? 0
  browserSessionProxyApplicationGenerations.set(sess, generation + 1)
}

/** Re-apply the app-wide proxy across every browser partition. */
export async function applyBrowserSessionProxies(
  profiles: BrowserSessionProfile[],
  settings?: NetworkProxySettings
): Promise<void> {
  const resolved = settings ?? resolveNetworkProxySettings?.()
  if (!resolved) {
    return
  }
  proxyPolicyGeneration += 1
  const failedPartitions = (
    await Promise.all(
      profiles.map(async (profile) => {
        try {
          await applyProxySettingsToSession(session.fromPartition(profile.partition), resolved)
          return null
        } catch {
          console.warn('[proxy] Failed to apply proxy to browser partition', profile.partition)
          return profile.partition
        }
      })
    )
  ).filter((partition): partition is string => partition !== null)
  if (failedPartitions.length > 0) {
    throw new Error(`Failed to apply proxy to browser partitions: ${failedPartitions.join(', ')}`)
  }
}
