// CLOUD-BROWSER-DIRECT: an Orca Cloud sandbox's egress terminates TLS for hosts that carry credential rules
// (github.com, model APIs), so a public site browsed through it would present the sandbox provider's CA,
// which the desktop must never trust (seen: ERR_CERT_AUTHORITY_INVALID on github.com). An Orca Cloud browser
// route therefore sends only the workspace's own loopback through the sandbox (its dev servers and forwarded
// ports); every other site is dialed from this desktop, as a local workspace's browser would be.
import type { Duplex } from 'node:stream'
import type { BrowserNetworkTunnelOpen } from '../../../../shared/browser/network/tunnels/browser-network-tunnel-protocol'

/** How an Orca Cloud route reaches sites outside the workspace: from this desktop, never through the sandbox. */
export type LoopbackOnlyRoute = {
  connectPublic: (target: BrowserNetworkTunnelOpen) => Promise<Duplex>
}

/** The desktop-side connection for a target outside the workspace, or null when it belongs to the sandbox. */
export function openOutsideWorkspace(
  route: LoopbackOnlyRoute | undefined,
  target: BrowserNetworkTunnelOpen
): Promise<Duplex> | null {
  return route && !isWorkspaceLoopbackHost(target.host) ? route.connectPublic(target) : null
}

/** The workspace's own machine as a browser names it: what an Orca Cloud route still sends through the sandbox. */
export function isWorkspaceLoopbackHost(host: string): boolean {
  const name = host
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
  return (
    name === 'localhost' ||
    name.endsWith('.localhost') ||
    name === '::1' ||
    name === '0.0.0.0' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name) ||
    /^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name)
  )
}
