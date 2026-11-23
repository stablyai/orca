import type { BrowserNetworkTunnelOpen } from '../../shared/browser/network/tunnels/browser-network-tunnel-protocol'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/** The port of a simulator helper URL on its host's loopback, or `null` for any other URL. */
export function emulatorLoopbackUrlPort(url: string): number | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)) {
    return null
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) {
    return null
  }
  const port = Number(parsed.port)
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null
}

/** Paired desktops may reach only the loopback ports of this host's registered simulator helpers. */
export function emulatorTunnelTargetAllowed(
  target: BrowserNetworkTunnelOpen,
  sessionEndpointUrls: readonly string[]
): boolean {
  if (!LOOPBACK_HOSTS.has(target.host.toLowerCase())) {
    return false
  }
  return sessionEndpointUrls.some((url) => emulatorLoopbackUrlPort(url) === target.port)
}
