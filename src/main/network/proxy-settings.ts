import type { Session } from 'electron'

/**
 * The default proxy session, or null on a host with no Chromium.
 *
 * Why settable: `session.defaultSession` is the only Electron value this module needs,
 * and callers already accept an explicit `options.proxySession`. Making the *default*
 * injectable lets the module load under plain Node, where there is no Chromium proxy
 * config to consult and the environment variables are the whole answer.
 */
let resolveDefaultProxySession: (() => Session | null) | null = null

/**
 * Why a resolver and not a Session: `session.defaultSession` throws until the Electron
 * app is ready, and this is installed during pre-ready bootstrap. Passing a getter
 * defers the access to first use, which is always after ready.
 */
export function setDefaultProxySessionResolver(resolve: (() => Session | null) | null): void {
  resolveDefaultProxySession = resolve
}

function defaultProxySession(): Session | null {
  return resolveDefaultProxySession?.() ?? null
}

/** Apply proxy rules only when a Chromium session exists; a Node host has none to configure. */
async function setSessionProxyIfPresent(
  proxySession: ProxySession | Session | null,
  config: Parameters<typeof setSessionProxy>[1]
): Promise<void> {
  if (!proxySession) {
    return
  }
  await setSessionProxy(proxySession as ProxySession, config)
}
import {
  getProxyBypassRulesFromEnvironment,
  getProxyUrlFromEnvironment,
  normalizeProxyBypassRules,
  normalizeProxyUrl,
  type NetworkProxySettings
} from '../../shared/network-proxy'

type ProxySession = {
  resolveProxy(url: string): Promise<string>
  setProxy(config: {
    mode?: 'system' | 'fixed_servers'
    proxyRules?: string
    proxyBypassRules?: string
  }): Promise<void>
  closeAllConnections?: () => Promise<void>
}

export type ProxyApplyResult =
  | { source: 'settings'; proxyRules: string; proxyBypassRules?: string }
  | { source: 'env'; proxyRules: string; proxyBypassRules?: string }
  | { source: 'system' | 'none' | 'invalid-settings' | 'invalid-env' }

const PROXY_PROBE_URL = 'https://api.anthropic.com/'

let lastAppliedProxyConfig: Extract<ProxyApplyResult, { source: 'settings' | 'env' }> | null = null

async function setSessionProxy(
  proxySession: ProxySession,
  config: Parameters<ProxySession['setProxy']>[0]
): Promise<void> {
  await proxySession.setProxy(config)
  await proxySession.closeAllConnections?.()
}

export function resetProxyApplicationForTests(): void {
  lastAppliedProxyConfig = null
}

export async function ensureElectronProxyFromEnvironment(
  options: {
    proxySession?: ProxySession
    env?: Record<string, string | undefined>
    force?: boolean
    probeUrl?: string
  } = {}
): Promise<ProxyApplyResult> {
  if (!options.force && lastAppliedProxyConfig !== null) {
    return lastAppliedProxyConfig
  }

  const proxySession = options.proxySession ?? defaultProxySession()
  // Why not bail: with no Chromium session there is no system proxy to discover, so the
  // environment variables below are the complete answer rather than a fallback.
  const resolved = proxySession
    ? await proxySession.resolveProxy(options.probeUrl ?? PROXY_PROBE_URL)
    : 'DIRECT'
  if (resolved !== 'DIRECT') {
    return { source: 'system' }
  }

  const proxy = getProxyUrlFromEnvironment(options.env ?? process.env)
  if (!proxy.ok) {
    return { source: 'invalid-env' }
  }
  if (!proxy.value) {
    return { source: 'none' }
  }

  const bypassRules = getProxyBypassRulesFromEnvironment(options.env ?? process.env)
  await setSessionProxyIfPresent(proxySession, {
    mode: 'fixed_servers',
    proxyRules: proxy.value,
    ...(bypassRules ? { proxyBypassRules: bypassRules } : {})
  })
  lastAppliedProxyConfig = {
    source: 'env',
    proxyRules: proxy.value,
    ...(bypassRules ? { proxyBypassRules: bypassRules } : {})
  }
  return lastAppliedProxyConfig
}

export async function applyElectronProxySettings(
  settings: NetworkProxySettings,
  options: {
    proxySession?: ProxySession
    env?: Record<string, string | undefined>
    probeUrl?: string
  } = {}
): Promise<ProxyApplyResult> {
  const proxySession = options.proxySession ?? defaultProxySession()
  const proxy = normalizeProxyUrl(settings.httpProxyUrl)
  if (!proxy.ok) {
    return ensureElectronProxyFromEnvironment({
      ...(proxySession ? { proxySession } : {}),
      env: options.env,
      force: lastAppliedProxyConfig !== null,
      probeUrl: options.probeUrl
    }).then((result) => (result.source === 'none' ? { source: 'invalid-settings' } : result))
  }

  // Why guarded: applying proxy rules to a Chromium session is meaningless with no
  // Chromium. The settings are still honoured — outbound requests read the environment.
  if (proxy.value) {
    const bypassRules = normalizeProxyBypassRules(settings.httpProxyBypassRules)
    await setSessionProxyIfPresent(proxySession, {
      mode: 'fixed_servers',
      proxyRules: proxy.value,
      ...(bypassRules ? { proxyBypassRules: bypassRules } : {})
    })
    lastAppliedProxyConfig = {
      source: 'settings',
      proxyRules: proxy.value,
      ...(bypassRules ? { proxyBypassRules: bypassRules } : {})
    }
    return lastAppliedProxyConfig
  }

  if (lastAppliedProxyConfig !== null) {
    await setSessionProxyIfPresent(proxySession, { mode: 'system' })
    lastAppliedProxyConfig = null
  }
  return ensureElectronProxyFromEnvironment({
    ...(proxySession ? { proxySession } : {}),
    env: options.env,
    force: true,
    probeUrl: options.probeUrl
  })
}
