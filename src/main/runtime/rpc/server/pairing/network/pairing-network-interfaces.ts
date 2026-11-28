import { isIP } from 'node:net'
import { networkInterfaces } from 'node:os'
import {
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
  // Unknown default route cannot attest vEthernet reachability.
  const defaultRouteInterfaceNames = hasHyperVInterface
    ? await getDefaultRouteInterfaceNames()
    : new Set<string>()
  const normalizedDefaultRouteInterfaceNames =
    defaultRouteInterfaceNames === null
      ? null
      : new Set([...defaultRouteInterfaceNames].map((name) => name.toLowerCase()))

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
      result.push({
        name,
        address: addr.address,
        ...(normalizedDefaultRouteInterfaceNames?.has(name.toLowerCase())
          ? { hasDefaultRoute: true }
          : {})
      })
    }
  }
  return result.sort((a, b) => rankInterface(a) - rankInterface(b))
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
