export type ProxySession = {
  resolveProxy(url: string): Promise<string>
  setProxy(config: {
    mode?: 'system' | 'fixed_servers'
    proxyRules?: string
    proxyBypassRules?: string
  }): Promise<void>
  closeAllConnections?: () => Promise<void>
}

let resolveDefaultProxySession: (() => ProxySession | null) | null = null

export function setDefaultProxySessionResolver(resolve: (() => ProxySession | null) | null): void {
  resolveDefaultProxySession = resolve
}

export function defaultProxySession(): ProxySession | null {
  return resolveDefaultProxySession?.() ?? null
}
