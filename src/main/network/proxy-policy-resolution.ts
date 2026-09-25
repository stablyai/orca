import {
  getProxyBypassRulesFromEnvironment,
  getProxyUrlFromEnvironment,
  normalizeProxyBypassRules,
  normalizeProxyUrl,
  type NetworkProxySettings
} from '../../shared/network-proxy'
import { separateElectronProxyCredentials } from './electron-proxy-credentials'

export type ProxyApplyResult =
  | { source: 'settings'; proxyRules: string; proxyBypassRules?: string }
  | { source: 'env'; proxyRules: string; proxyBypassRules?: string }
  | { source: 'system' | 'none' | 'invalid-settings' | 'invalid-env' }

export function resolveProxyPolicyWithoutSession(
  settings: NetworkProxySettings,
  env: Record<string, string | undefined>
): ProxyApplyResult {
  const configured = normalizeProxyUrl(settings.httpProxyUrl)
  if (configured.ok && configured.value) {
    const { proxyRules } = separateElectronProxyCredentials(configured.value)
    const bypassRules = normalizeProxyBypassRules(settings.httpProxyBypassRules)
    return {
      source: 'settings',
      proxyRules,
      ...(bypassRules ? { proxyBypassRules: bypassRules } : {})
    }
  }

  const envProxy = getProxyUrlFromEnvironment(env)
  if (envProxy.ok && envProxy.value) {
    const { proxyRules } = separateElectronProxyCredentials(envProxy.value)
    const bypassRules = normalizeProxyBypassRules(getProxyBypassRulesFromEnvironment(env))
    return {
      source: 'env',
      proxyRules,
      ...(bypassRules ? { proxyBypassRules: bypassRules } : {})
    }
  }
  if (!configured.ok) {
    return { source: 'invalid-settings' }
  }
  return { source: envProxy.ok ? 'none' : 'invalid-env' }
}
