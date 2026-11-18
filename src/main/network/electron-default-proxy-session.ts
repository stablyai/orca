export type SessionProxyConfig = {
  mode?: 'system' | 'fixed_servers' | 'direct' | 'auto_detect' | 'pac_script'
  proxyRules?: string
  proxyBypassRules?: string
  pacScript?: string
}

export type ProxySession = {
  resolveProxy(url: string): Promise<string>
  setProxy(config: SessionProxyConfig): Promise<void>
  closeAllConnections?: () => Promise<void>
  forceReloadProxyConfig?: () => Promise<void>
}

let resolveDefaultProxySession: (() => ProxySession | null) | null = null

export function setDefaultProxySessionResolver(resolve: (() => ProxySession | null) | null): void {
  resolveDefaultProxySession = resolve
}

export function defaultProxySession(): ProxySession | null {
  return resolveDefaultProxySession?.() ?? null
}
