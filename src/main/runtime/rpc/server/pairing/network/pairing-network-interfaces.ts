import { isIP } from 'node:net'
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os'
import {
  isAutoAdvertisablePairingInterface,
  isVirtualBridgeInterface,
  selectAutoAdvertisedPairingAddress
} from '../../../../../../shared/remote-runtime/pairing/pairing-address-auto-selection'
import { isLinkLocalAddress } from '../../../../../../shared/network/link-local-address'
import { isTailnetIPv4Address } from '../../../../../../shared/network/tailnet-address'
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
function listenerServesFamily(listenerHost: string, family: 'IPv4' | 'IPv6'): boolean {
  const listenerFamily = isIP(listenerHost)
  if (listenerFamily === 6 && /^[0:]+$/.test(listenerHost)) {
    return true
  }
  return listenerFamily === (family === 'IPv6' ? 6 : 4)
}

function isProxyFakeIpIPv4Address(address: string): boolean {
  return /^198\.(?:18|19)\./.test(address)
}

/** `listenerHost` is the WS listener's network bind; only addresses of a family it accepts are offered. */
export async function getPairingNetworkInterfaces(
  listenerHost: string,
  getDefaultRouteInterfaceNames: DefaultRouteInterfaceLookup = getWindowsDefaultRouteInterfaceNames
): Promise<NetworkInterface[]> {
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
        isLinkLocalAddress(addr.address)
      ) {
        continue
      }
      if (!listenerServesFamily(listenerHost, addr.family)) {
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
  // The default-route adapter is the one the LAN reaches; it wins ties with idle or VPN adapters.
  const defaultRouteBonus = hasDefaultRoute ? 0.5 : 0
  return (address.includes(':') ? 2 : 1) + bridgePenalty - defaultRouteBonus
}

export async function getDefaultPairingAddress(
  listenerHost: string,
  getDefaultRouteInterfaceNames: DefaultRouteInterfaceLookup = getWindowsDefaultRouteInterfaceNames
): Promise<string | null> {
  return (
    selectAutoAdvertisedPairingAddress(
      await getPairingNetworkInterfaces(listenerHost, getDefaultRouteInterfaceNames)
    ) ?? null
  )
}
