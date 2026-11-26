import {
  buildConfiguredProxyEnv,
  getProxyBypassRulesFromEnvironment,
  normalizeProxyUrl,
  PROXY_ENV_KEYS,
  type NetworkProxySettings
} from '../../shared/network/network-proxy'
import { withTimeout } from '../../shared/concurrency/promise-timeout-fallback'
import { readNetworkProxySettings } from '../browser/network/execution-routes/browser-network-proxy-settings-source'
import { defaultProxySession } from './electron-default-proxy-session'

const GO_NET_HTTP_UNSUPPORTED_PROXY_PROTOCOLS = new Set(['socks:', 'socks4:'])
const PROXY_URL_KEYS = new Set(PROXY_ENV_KEYS.map((key) => key.toLowerCase()))
const SYSTEM_PROXY_RESOLVE_TIMEOUT_MS = 1_500
const SYSTEM_PROXY_SCHEME_BY_TYPE = new Map<string, string>([
  ['PROXY', 'http'],
  ['HTTPS', 'https'],
  ['SOCKS5', 'socks5']
])

export type SystemProxyRule = {
  proxyUrl: string | null
  hasDirectFallback: boolean
}

export type ResolvedProxyChildEnv = {
  env: NodeJS.ProcessEnv
  usedSystemProxy: boolean
  hasDirectFallback: boolean
}

function hasInheritedProxy(env: NodeJS.ProcessEnv): boolean {
  return Object.entries(env).some(
    ([key, value]) => PROXY_URL_KEYS.has(key.toLowerCase()) && Boolean(value?.trim())
  )
}

export function parseSystemProxyRule(proxyString: string): SystemProxyRule {
  let proxyUrl: string | null = null
  for (const rawEntry of proxyString.split(';')) {
    const entry = rawEntry.trim()
    if (!entry) {
      continue
    }
    if (entry.toUpperCase() === 'DIRECT') {
      return { proxyUrl, hasDirectFallback: true }
    }
    if (proxyUrl !== null) {
      continue
    }
    const parts = entry.split(/\s+/)
    if (parts.length !== 2) {
      continue
    }
    const [directive, hostPort] = parts
    const scheme = SYSTEM_PROXY_SCHEME_BY_TYPE.get(directive.toUpperCase())
    if (!scheme || !hostPort || /[/?#@\\]/.test(hostPort)) {
      continue
    }
    const normalized = normalizeProxyUrl(`${scheme}://${hostPort}`)
    if (!normalized.ok || !normalized.value) {
      continue
    }
    proxyUrl = normalized.value
  }
  return { proxyUrl, hasDirectFallback: false }
}

// For Go-based CLIs such as glab: unlike buildConfiguredProxyEnv's shared policy, an inherited
// proxy env wins and NO_PROXY is unioned so no working setup regresses.
export function withConfiguredProxyEnv(
  env: NodeJS.ProcessEnv | undefined,
  settings = readNetworkProxySettings()
): NodeJS.ProcessEnv | undefined {
  const proxyEnv = buildConfiguredProxyEnv(settings)
  const proxyUrl = proxyEnv.HTTPS_PROXY
  if (!proxyUrl || GO_NET_HTTP_UNSUPPORTED_PROXY_PROTOCOLS.has(new URL(proxyUrl).protocol)) {
    return env
  }
  const baseEnv = env ?? process.env
  if (hasInheritedProxy(baseEnv)) {
    return env
  }
  const bypassRules = [
    ...getProxyBypassRulesFromEnvironment(baseEnv).split(';'),
    ...proxyEnv.NO_PROXY.split(',')
  ].filter(Boolean)
  const noProxy = [...new Set(bypassRules)].join(',')
  return { ...baseEnv, ...proxyEnv, NO_PROXY: noProxy, no_proxy: noProxy }
}

export function shouldRetryDirectAfterSystemProxyFailure(
  output: string,
  hasDirectFallback: boolean
): boolean {
  return (
    /proxy authentication required|\b407\b.*proxy|proxy.*\b407\b/i.test(output) ||
    (hasDirectFallback && /proxyconnect/i.test(output))
  )
}

export async function resolveConfiguredOrSystemProxyEnv(
  env: NodeJS.ProcessEnv,
  options: {
    targetUrl: string
    settings?: NetworkProxySettings | null
    signal?: AbortSignal
  }
): Promise<ResolvedProxyChildEnv> {
  if (hasInheritedProxy(env)) {
    return { env, usedSystemProxy: false, hasDirectFallback: false }
  }
  const resolvedSettings =
    options.settings === undefined ? readNetworkProxySettings() : options.settings
  if (resolvedSettings?.httpProxyUrl?.trim()) {
    return {
      env: withConfiguredProxyEnv(env, resolvedSettings) ?? env,
      usedSystemProxy: false,
      hasDirectFallback: false
    }
  }
  if (options.signal?.aborted) {
    return { env, usedSystemProxy: false, hasDirectFallback: false }
  }
  const session = defaultProxySession()
  if (!session) {
    return { env, usedSystemProxy: false, hasDirectFallback: false }
  }
  // Bound PAC/WPAD lookup so a slow system resolver cannot stall the probe budget.
  const resolved = await withTimeout(
    Promise.resolve().then(() => session.resolveProxy(options.targetUrl)),
    SYSTEM_PROXY_RESOLVE_TIMEOUT_MS,
    ''
  )
  const { proxyUrl, hasDirectFallback } = parseSystemProxyRule(
    typeof resolved === 'string' ? resolved : ''
  )
  if (!proxyUrl) {
    return { env, usedSystemProxy: false, hasDirectFallback }
  }
  return {
    env: withConfiguredProxyEnv(env, { httpProxyUrl: proxyUrl, httpProxyBypassRules: '' }) ?? env,
    usedSystemProxy: true,
    hasDirectFallback
  }
}
