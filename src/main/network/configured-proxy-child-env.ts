import {
  buildConfiguredProxyEnv,
  getProxyBypassRulesFromEnvironment,
  PROXY_ENV_KEYS
} from '../../shared/network/network-proxy'
import { readNetworkProxySettings } from '../browser/network/execution-routes/browser-network-proxy-settings-source'

const GO_NET_HTTP_UNSUPPORTED_PROXY_PROTOCOLS = new Set(['socks:', 'socks4:'])
const PROXY_URL_KEYS = new Set(PROXY_ENV_KEYS.map((key) => key.toLowerCase()))

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
  const hasInheritedProxy = Object.entries(baseEnv).some(
    ([key, value]) => PROXY_URL_KEYS.has(key.toLowerCase()) && Boolean(value?.trim())
  )
  if (hasInheritedProxy) {
    return env
  }
  const bypassRules = [
    ...getProxyBypassRulesFromEnvironment(baseEnv).split(';'),
    ...proxyEnv.NO_PROXY.split(',')
  ].filter(Boolean)
  const noProxy = [...new Set(bypassRules)].join(',')
  return { ...baseEnv, ...proxyEnv, NO_PROXY: noProxy, no_proxy: noProxy }
}
