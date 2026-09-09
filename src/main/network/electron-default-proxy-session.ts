import type { ProxyCaTrustSession } from './proxy-ca-trust'

export type ProxySession = {
  resolveProxy(url: string): Promise<string>
  setProxy(config: {
    mode?: 'system' | 'fixed_servers'
    proxyRules?: string
    proxyBypassRules?: string
  }): Promise<void>
  closeAllConnections?: () => Promise<void>
  /** Optional: only sessions that can host the proxy-CA override implement it. */
  setCertificateVerifyProc?: ProxyCaTrustSession['setCertificateVerifyProc']
}

let resolveDefaultProxySession: (() => ProxySession | null) | null = null

export function setDefaultProxySessionResolver(resolve: (() => ProxySession | null) | null): void {
  resolveDefaultProxySession = resolve
}

export function defaultProxySession(): ProxySession | null {
  return resolveDefaultProxySession?.() ?? null
}
