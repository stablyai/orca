import { session, type Session } from 'electron'
import {
  getProxyBypassRulesFromEnvironment,
  getProxyUrlFromEnvironment,
  normalizeProxyBypassRules,
  normalizeProxyUrl,
  type NetworkProxySettings
} from '../../shared/network-proxy'

export const OLLAMA_CLOUD_BASE_URL = 'https://ollama.com'

const OLLAMA_CLOUD_SESSION_PARTITION = 'orca-ollama-cloud-rate-limit-fetch'
const appliedProxyKeys = new WeakMap<Session, string>()

export async function clearOllamaCloudSessionCookies(ollamaCloudSession: Session): Promise<void> {
  await ollamaCloudSession.clearStorageData({ origin: OLLAMA_CLOUD_BASE_URL, storages: ['cookies'] })
}

async function setOllamaCloudSessionProxy(
  ollamaCloudSession: Session,
  proxyRules: string,
  proxyBypassRules: string,
  source: 'settings' | 'env'
): Promise<void> {
  const key = `${source}\0${proxyRules}\0${proxyBypassRules}`
  if (appliedProxyKeys.get(ollamaCloudSession) === key) {
    return
  }
  await ollamaCloudSession.setProxy({
    mode: 'fixed_servers',
    proxyRules,
    ...(proxyBypassRules ? { proxyBypassRules } : {})
  })
  await ollamaCloudSession.closeAllConnections()
  appliedProxyKeys.set(ollamaCloudSession, key)
}

async function ensureEnvironmentProxyForOllamaCloudSession(ollamaCloudSession: Session): Promise<void> {
  const envProxy = getProxyUrlFromEnvironment(process.env)
  const proxyBypassRules = getProxyBypassRulesFromEnvironment(process.env)
  const envKey =
    envProxy.ok && envProxy.value ? `env\0${envProxy.value}\0${proxyBypassRules}` : null
  if (envKey && appliedProxyKeys.get(ollamaCloudSession) === envKey) {
    return
  }
  if (appliedProxyKeys.has(ollamaCloudSession)) {
    await ollamaCloudSession.setProxy({ mode: 'system' })
    await ollamaCloudSession.closeAllConnections()
    appliedProxyKeys.delete(ollamaCloudSession)
  }
  // Environment proxy bridging is best-effort, matching the app-wide startup path.
  try {
    if ((await ollamaCloudSession.resolveProxy(OLLAMA_CLOUD_BASE_URL)) !== 'DIRECT') {
      return
    }
    if (!envProxy.ok || !envProxy.value) {
      return
    }
    await setOllamaCloudSessionProxy(ollamaCloudSession, envProxy.value, proxyBypassRules, 'env')
  } catch {
    // Direct networking remains available when optional environment bridging fails.
  }
}

async function ensureProxyForOllamaCloudSession(
  ollamaCloudSession: Session,
  networkProxySettings?: NetworkProxySettings
): Promise<void> {
  const configuredProxy = normalizeProxyUrl(networkProxySettings?.httpProxyUrl)
  if (configuredProxy.ok && configuredProxy.value) {
    await setOllamaCloudSessionProxy(
      ollamaCloudSession,
      configuredProxy.value,
      normalizeProxyBypassRules(networkProxySettings?.httpProxyBypassRules),
      'settings'
    )
    return
  }

  await ensureEnvironmentProxyForOllamaCloudSession(ollamaCloudSession)
}

export async function createOllamaCloudRequestSession(
  authCookies: { name: string; value: string }[],
  networkProxySettings?: NetworkProxySettings
): Promise<Session> {
  const ollamaCloudSession = session.fromPartition(OLLAMA_CLOUD_SESSION_PARTITION)
  await clearOllamaCloudSessionCookies(ollamaCloudSession)
  // The isolated cookie jar must still honor Orca, environment, and system proxies.
  await ensureProxyForOllamaCloudSession(ollamaCloudSession, networkProxySettings)
  try {
    // Sequential writes ensure cleanup cannot race an in-flight cookie write after a rejection.
    for (const { name, value } of authCookies) {
      await ollamaCloudSession.cookies.set({
        url: OLLAMA_CLOUD_BASE_URL,
        name,
        value,
        secure: true,
        path: '/'
      })
    }
    return ollamaCloudSession
  } catch (error) {
    await clearOllamaCloudSessionCookies(ollamaCloudSession).catch(() => undefined)
    throw error
  }
}
