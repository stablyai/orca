import type { NetworkProxySettings } from '../../shared/network-proxy'

// Tunnel hosts share this source without importing Electron into the plain-Node runtime.
let resolveNetworkProxySettings: (() => NetworkProxySettings) | null = null

export function setNetworkProxySettingsSource(resolver: (() => NetworkProxySettings) | null): void {
  resolveNetworkProxySettings = resolver
}

export function readNetworkProxySettings(): NetworkProxySettings | null {
  return resolveNetworkProxySettings?.() ?? null
}
