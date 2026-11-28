import { isIP } from 'node:net'
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os'
import {
  isAutoAdvertisablePairingInterface,
  isTunnelInterface,
  isVirtualBridgeInterface,
  selectAutoAdvertisedPairingAddress
} from '../../../../../../shared/remote-runtime/pairing/pairing-address-auto-selection'
import { isLinkLocalAddress } from '../../../../../../shared/network/link-local-address'
import { isTailnetIPv4Address } from '../../../../../../shared/network/tailnet-address'
import { isPairingWildcardHostname } from '../../../../../../shared/network/pairing-url'
import { classifyRemotePairingHostname } from '../../../../../../shared/remote-runtime/pairing/remote-pairing-address'
import { getWindowsDefaultRouteInterfaceNames } from './windows-default-route-interfaces'

export type NetworkInterface = {
  name: string
  address: string
  hasDefaultRoute?: boolean
}

export type DefaultRouteInterfaceLookup = () => Promise<ReadonlySet<string> | null>

// One route lookup per adapter snapshot: the PowerShell spawn costs ~0.5 s on Windows. The TTL bounds
// staleness when a tunnel changes the default route without adding an adapter.
const ROUTE_NAMES_TTL_MS = 60_000
let cachedRouteNames: { snapshot: string; names: ReadonlySet<string>; at: number } | null = null

/** A failed lookup stays uncached so the next pairing screen retries it. */
async function defaultRouteNamesFor(
  snapshot: string,
  lookup: DefaultRouteInterfaceLookup
): Promise<ReadonlySet<string> | null> {
  if (
    cachedRouteNames?.snapshot === snapshot &&
    Date.now() - cachedRouteNames.at < ROUTE_NAMES_TTL_MS
  ) {
    return cachedRouteNames.names
  }
  const names = await lookup()
  if (names) {
    cachedRouteNames = { snapshot, names, at: Date.now() }
  }
  return names
}

/** The route bonus only decides anything when the best non-Tailscale candidates rank equal. */
function hasRankTie(interfaces: readonly NetworkInterface[]): boolean {
  // A bridge is dropped before selection, so it can neither win the rank nor stand in for Tailscale.
  const advertisable = interfaces.filter(isAutoAdvertisablePairingInterface)
  // A Tailscale address wins every tie at rank 0, so the bonus cannot change the advertised one.
  if (advertisable.some((iface) => isTailnetIPv4Address(iface.address))) {
    return false
  }
  let best = Number.POSITIVE_INFINITY
  let bestCount = 0
  for (const iface of advertisable) {
    const rank = rankInterface(iface)
    if (rank < best) {
      best = rank
      bestCount = 1
    } else if (rank === best) {
      bestCount += 1
    }
  }
  return bestCount > 1
}

// 0.0.0.0 cannot accept IPv6; only an IPv6 bind can offer both families (#31161).
// `host` is a canonical IP literal.
function listenerServesFamily(host: string, family: 'IPv4' | 'IPv6'): boolean {
  const listenerFamily = isIP(host)
  if (listenerFamily === 6 && /^[0:]+$/.test(host)) {
    return true
  }
  // An IPv4-mapped bind (`::ffff:0.0.0.0`) accepts only IPv4.
  if (listenerFamily === 6 && host.startsWith('::ffff:')) {
    return family === 'IPv4'
  }
  return listenerFamily === (family === 'IPv6' ? 6 : 4)
}

function isProxyFakeIpIPv4Address(address: string): boolean {
  return /^198\.(?:18|19)\./.test(address)
}

/** `listenerHost` is the WS listener's network bind; only addresses it answers on are offered. */
export async function getPairingNetworkInterfaces(
  listenerHost: string,
  getDefaultRouteInterfaceNames: DefaultRouteInterfaceLookup = getWindowsDefaultRouteInterfaceNames
): Promise<NetworkInterface[]> {
  const pinned = pinnedListenerAddress(listenerHost)
  if (pinned === null) {
    return []
  }
  const pinnedCanonical = pinned === undefined ? undefined : canonicalIpLiteral(pinned)
  const listenerCanonical = canonicalIpLiteral(listenerHost)
  const result: NetworkInterface[] = []
  const interfaces = networkInterfaces()
  const hasHyperVInterface = Object.keys(interfaces).some((name) => /^vEthernet /i.test(name))

  for (const [name, addrs] of Object.entries(interfaces)) {
    for (const addr of addrs ?? []) {
      if (
        addr.internal ||
        (addr.family !== 'IPv4' && addr.family !== 'IPv6') ||
        (addr.family === 'IPv4' && isProxyFakeIpIPv4Address(addr.address)) ||
        // An APIPA/idle adapter's 169.254 or fe80 address is never dialable from the phone.
        isLinkLocalAddress(addr.address) ||
        (pinnedCanonical !== undefined && canonicalIpLiteral(addr.address) !== pinnedCanonical)
      ) {
        continue
      }
      if (!listenerServesFamily(listenerCanonical, addr.family)) {
        continue
      }
      result.push({ name, address: addr.address })
    }
  }
  // Ask only when the answer can change the ranking: vEthernet reachability, or a tie the bonus breaks.
  const defaultRouteInterfaceNames =
    hasHyperVInterface || hasRankTie(result)
      ? await defaultRouteNamesFor(snapshotOf(interfaces), getDefaultRouteInterfaceNames)
      : null
  const normalizedDefaultRouteInterfaceNames =
    defaultRouteInterfaceNames === null
      ? null
      : new Set([...defaultRouteInterfaceNames].map((name) => name.toLowerCase()))

  return result
    .map((iface) =>
      normalizedDefaultRouteInterfaceNames?.has(iface.name.toLowerCase())
        ? { ...iface, hasDefaultRoute: true }
        : iface
    )
    .sort((a, b) => rankInterface(a) - rankInterface(b))
}

/** The adapter list itself: route names are only reused while the machine's set of adapters is unchanged. */
function snapshotOf(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>): string {
  return Object.keys(interfaces).sort().join('\n')
}

function rankInterface({ name, address, hasDefaultRoute }: NetworkInterface): number {
  if (isTailnetIPv4Address(address)) {
    return 0
  }
  const bridgePenalty = isVirtualBridgeInterface(name, hasDefaultRoute) ? 2 : 0
  // A tunnel's default route is synthetic: keep it behind the LAN even when it holds the route.
  const tunnelPenalty = isTunnelInterface(name) ? 2 : 0
  // The default-route adapter is the one the LAN reaches; it wins ties with idle or VPN adapters.
  const defaultRouteBonus = hasDefaultRoute ? 0.5 : 0
  return (address.includes(':') ? 2 : 1) + bridgePenalty + tunnelPenalty - defaultRouteBonus
}

// Every spelling of an IPv6 literal (`::`, `0:0:0:0:0:0:0:1`, `::ffff:127.0.0.1`) compares alike.
function canonicalIpLiteral(address: string): string {
  const host = address.replace(/^\[|\]$/g, '')
  return isIP(host) === 6 ? new URL(`http://[${host}]`).hostname.slice(1, -1) : host
}

/** A pinned listener answers only on its own address, and on none a client can dial when it is loopback; undefined for a wildcard listener. */
export function pinnedListenerAddress(listenerHost: string): string | null | undefined {
  const host = listenerHost.replace(/^\[|\]$/g, '')
  const canonical = canonicalIpLiteral(host)
  if (isPairingWildcardHostname(canonical)) {
    return undefined
  }
  return classifyRemotePairingHostname(canonical) === 'loopback' ? null : host
}

export async function getDefaultPairingAddress(
  listenerHost: string,
  getDefaultRouteInterfaceNames: DefaultRouteInterfaceLookup = getWindowsDefaultRouteInterfaceNames
): Promise<string | null> {
  const pinned = pinnedListenerAddress(listenerHost)
  if (pinned !== undefined) {
    return pinned
  }
  return (
    selectAutoAdvertisedPairingAddress(
      await getPairingNetworkInterfaces(listenerHost, getDefaultRouteInterfaceNames)
    ) ?? null
  )
}
