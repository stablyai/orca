import type { NetworkProxySettings } from '../../shared/network-proxy'

// Why its own module: the runtime's tunnel host reads it and must boot on plain Node, without Electron.
let resolveNetworkProxySettings: (() => NetworkProxySettings) | null = null

export function setNetworkProxySettingsSource(resolver: (() => NetworkProxySettings) | null): void {
  resolveNetworkProxySettings = resolver
}

/** The app's proxy settings, or null when no store has been wired (plain-Node hosts). */
export function readNetworkProxySettings(): NetworkProxySettings | null {
  return resolveNetworkProxySettings?.() ?? null
}
