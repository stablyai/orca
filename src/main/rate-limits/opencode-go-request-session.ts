import type { Session } from 'electron'
import { requirePartitionSession } from '../network/http-client'
import {
  getProxyBypassRulesFromEnvironment,
  getProxyUrlFromEnvironment,
  normalizeProxyBypassRules,
  normalizeProxyUrl,
  type NetworkProxySettings
} from '../../shared/network-proxy'

export const OPENCODE_BASE_URL = 'https://opencode.ai'

const OPENCODE_SESSION_PARTITION = 'orca-opencode-go-rate-limit-fetch'
const appliedProxyKeys = new WeakMap<Session, string>()

export async function clearOpenCodeSessionCookies(openCodeSession: Session): Promise<void> {
  await openCodeSession.clearStorageData({ origin: OPENCODE_BASE_URL, storages: ['cookies'] })
}

async function setOpenCodeSessionProxy(
  openCodeSession: Session,
  proxyRules: string,
  proxyBypassRules: string,
  source: 'settings' | 'env',
  signal?: AbortSignal
): Promise<void> {
  signal?.throwIfAborted()
  const key = `${source}\0${proxyRules}\0${proxyBypassRules}`
  if (appliedProxyKeys.get(openCodeSession) === key) {
    return
  }
  appliedProxyKeys.delete(openCodeSession)
  await openCodeSession.setProxy({
    mode: 'fixed_servers',
    proxyRules,
    ...(proxyBypassRules ? { proxyBypassRules } : {})
  })
  signal?.throwIfAborted()
  await openCodeSession.closeAllConnections()
  signal?.throwIfAborted()
  appliedProxyKeys.set(openCodeSession, key)
}

async function ensureEnvironmentProxyForOpenCodeSession(
  openCodeSession: Session,
  signal?: AbortSignal
): Promise<void> {
  signal?.throwIfAborted()
  const envProxy = getProxyUrlFromEnvironment(process.env)
  const proxyBypassRules = getProxyBypassRulesFromEnvironment(process.env)
  const envKey =
    envProxy.ok && envProxy.value ? `env\0${envProxy.value}\0${proxyBypassRules}` : null
  if (envKey && appliedProxyKeys.get(openCodeSession) === envKey) {
    return
  }
  if (appliedProxyKeys.has(openCodeSession)) {
    appliedProxyKeys.delete(openCodeSession)
    await openCodeSession.setProxy({ mode: 'system' })
    signal?.throwIfAborted()
    await openCodeSession.closeAllConnections()
    signal?.throwIfAborted()
  }
  // Environment proxy bridging is best-effort, matching the app-wide startup path.
  try {
    const resolved = await openCodeSession.resolveProxy(OPENCODE_BASE_URL)
    signal?.throwIfAborted()
    if (resolved !== 'DIRECT') {
      return
    }
    if (!envProxy.ok || !envProxy.value) {
      return
    }
    await setOpenCodeSessionProxy(openCodeSession, envProxy.value, proxyBypassRules, 'env', signal)
  } catch {
    signal?.throwIfAborted()
    // Direct networking remains available when optional environment bridging fails.
  }
}

async function ensureProxyForOpenCodeSession(
  openCodeSession: Session,
  networkProxySettings?: NetworkProxySettings,
  signal?: AbortSignal
): Promise<void> {
  signal?.throwIfAborted()
  const configuredProxy = normalizeProxyUrl(networkProxySettings?.httpProxyUrl)
  if (configuredProxy.ok && configuredProxy.value) {
    await setOpenCodeSessionProxy(
      openCodeSession,
      configuredProxy.value,
      normalizeProxyBypassRules(networkProxySettings?.httpProxyBypassRules),
      'settings',
      signal
    )
    return
  }

  await ensureEnvironmentProxyForOpenCodeSession(openCodeSession, signal)
}

export async function createOpenCodeRequestSession(
  authCookies: { name: string; value: string }[],
  networkProxySettings?: NetworkProxySettings,
  signal?: AbortSignal
): Promise<Session> {
  signal?.throwIfAborted()
  const openCodeSession = requirePartitionSession(OPENCODE_SESSION_PARTITION, 'OpenCode Go')
  try {
    await clearOpenCodeSessionCookies(openCodeSession)
    signal?.throwIfAborted()
    await ensureProxyForOpenCodeSession(openCodeSession, networkProxySettings, signal)
    // Sequential writes ensure cleanup cannot race an in-flight cookie write after a rejection.
    for (const { name, value } of authCookies) {
      signal?.throwIfAborted()
      await openCodeSession.cookies.set({
        url: OPENCODE_BASE_URL,
        name,
        value,
        secure: true,
        path: '/'
      })
    }
    signal?.throwIfAborted()
    return openCodeSession
  } catch (error) {
    await clearOpenCodeSessionCookies(openCodeSession).catch(() => undefined)
    throw error
  }
}
