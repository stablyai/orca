import { session, type Session } from 'electron'
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
  source: 'settings' | 'env'
): Promise<void> {
  const key = `${source}\0${proxyRules}\0${proxyBypassRules}`
  if (appliedProxyKeys.get(openCodeSession) === key) {
    return
  }
  await openCodeSession.setProxy({
    mode: 'fixed_servers',
    proxyRules,
    ...(proxyBypassRules ? { proxyBypassRules } : {})
  })
  await openCodeSession.closeAllConnections()
  appliedProxyKeys.set(openCodeSession, key)
}

async function ensureEnvironmentProxyForOpenCodeSession(openCodeSession: Session): Promise<void> {
  const envProxy = getProxyUrlFromEnvironment(process.env)
  const proxyBypassRules = getProxyBypassRulesFromEnvironment(process.env)
  const envKey =
    envProxy.ok && envProxy.value ? `env\0${envProxy.value}\0${proxyBypassRules}` : null
  if (envKey && appliedProxyKeys.get(openCodeSession) === envKey) {
    return
  }
  if (appliedProxyKeys.has(openCodeSession)) {
    await openCodeSession.setProxy({ mode: 'system' })
    await openCodeSession.closeAllConnections()
    appliedProxyKeys.delete(openCodeSession)
  }
  // Environment proxy bridging is best-effort, matching the app-wide startup path.
  try {
    if ((await openCodeSession.resolveProxy(OPENCODE_BASE_URL)) !== 'DIRECT') {
      return
    }
    if (!envProxy.ok || !envProxy.value) {
      return
    }
    await setOpenCodeSessionProxy(openCodeSession, envProxy.value, proxyBypassRules, 'env')
  } catch {
    // Direct networking remains available when optional environment bridging fails.
  }
}

async function ensureProxyForOpenCodeSession(
  openCodeSession: Session,
  networkProxySettings?: NetworkProxySettings
): Promise<void> {
  const configuredProxy = normalizeProxyUrl(networkProxySettings?.httpProxyUrl)
  if (configuredProxy.ok && configuredProxy.value) {
    await setOpenCodeSessionProxy(
      openCodeSession,
      configuredProxy.value,
      normalizeProxyBypassRules(networkProxySettings?.httpProxyBypassRules),
      'settings'
    )
    return
  }

  await ensureEnvironmentProxyForOpenCodeSession(openCodeSession)
}

export async function createOpenCodeRequestSession(
  authCookies: { name: string; value: string }[],
  networkProxySettings?: NetworkProxySettings
): Promise<Session> {
  const openCodeSession = session.fromPartition(OPENCODE_SESSION_PARTITION)
  await clearOpenCodeSessionCookies(openCodeSession)
  // The isolated cookie jar must still honor Orca, environment, and system proxies.
  await ensureProxyForOpenCodeSession(openCodeSession, networkProxySettings)
  try {
    // Sequential writes ensure cleanup cannot race an in-flight cookie write after a rejection.
    for (const { name, value } of authCookies) {
      await openCodeSession.cookies.set({
        url: OPENCODE_BASE_URL,
        name,
        value,
        secure: true,
        path: '/'
      })
    }
    return openCodeSession
  } catch (error) {
    await clearOpenCodeSessionCookies(openCodeSession).catch(() => undefined)
    throw error
  }
}
