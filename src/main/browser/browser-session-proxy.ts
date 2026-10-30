import { session, type Session } from 'electron'
import type { BrowserSessionProfile } from '../../shared/browser-workspace-types'
import {
  applyProxySettingsToSession,
  awaitProxySessionApplication
} from '../network/proxy-settings'
import type { NetworkProxySettings } from '../../shared/network-proxy'
import {
  readNetworkProxySettings,
  setNetworkProxySettingsSource
} from './browser-network-proxy-settings-source'

let proxyPolicyGeneration = 0
// Stop stale readiness loops before a removed partition's queued proxy release.
const browserSessionProxyApplicationGenerations = new WeakMap<Session, number>()

export function setBrowserNetworkProxySettingsResolver(
  resolver: (() => NetworkProxySettings) | null
): void {
  setNetworkProxySettingsSource(resolver)
  if (!resolver) {
    proxyPolicyGeneration = 0
  }
}

export async function applyProxyToBrowserSession(sess: Session): Promise<void> {
  const applicationGeneration = browserSessionProxyApplicationGenerations.get(sess) ?? 0
  let observedGeneration: number
  do {
    observedGeneration = proxyPolicyGeneration
    const resolved = readNetworkProxySettings()
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

export async function applyBrowserSessionProxies(
  profiles: BrowserSessionProfile[],
  settings?: NetworkProxySettings
): Promise<void> {
  const resolved = settings ?? readNetworkProxySettings()
  if (!resolved) {
    return
  }
  proxyPolicyGeneration += 1
  await settleBrowserSessionProxyApplications(profiles, (sess) =>
    applyProxySettingsToSession(sess, resolved)
  )
}

export async function awaitBrowserSessionProxies(profiles: BrowserSessionProfile[]): Promise<void> {
  await settleBrowserSessionProxyApplications(profiles, async (sess) => {
    if (!(await awaitProxySessionApplication(sess))) {
      await applyProxyToBrowserSession(sess)
    }
  })
}

async function settleBrowserSessionProxyApplications(
  profiles: BrowserSessionProfile[],
  apply: (sess: Session) => Promise<unknown>
): Promise<void> {
  const failedPartitions = (
    await Promise.all(
      profiles.map(async (profile) => {
        try {
          await apply(session.fromPartition(profile.partition))
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
