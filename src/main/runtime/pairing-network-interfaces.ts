import { isIP } from 'node:net'
import { networkInterfaces } from 'node:os'
import {
  isVirtualBridgeInterface,
  selectAutoAdvertisedPairingAddress
} from '../../shared/pairing-address-auto-selection'
import { isTailnetIPv4Address } from '../../shared/tailnet-address'
import { getWindowsDefaultRouteInterfaceNames } from './windows-default-route-interfaces'

export type NetworkInterface = {
  name: string
  address: string
  hasDefaultRoute?: boolean
}

export type DefaultRouteInterfaceLookup = () => Promise<ReadonlySet<string> | null>

function isUsableIPv6Address(address: string): boolean {
  // Why: link-local IPv6 needs an unadvertised scope id, so a QR hostname cannot connect to it.
  return !/^fe[89ab][0-9a-f]:/i.test(address)
}

// Why: Node's `0.0.0.0` listener never accepts IPv6, so a v6 interface would mint a link nothing
// answers (#31161); only an IPv6 bind (`::` is dual-stack by default) serves both families.
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
  // Why: an unavailable route query is unknown, so no vEthernet adapter receives reachability proof.
  const defaultRouteInterfaceNames = hasHyperVInterface
    ? await getDefaultRouteInterfaceNames()
    : new Set<string>()
  const normalizedDefaultRouteInterfaceNames =
    defaultRouteInterfaceNames === null
      ? null
      : new Set([...defaultRouteInterfaceNames].map((name) => name.toLowerCase()))

  for (const [name, addrs] of Object.entries(interfaces)) {
    for (const addr of addrs ?? []) {
      if (addr.internal || (addr.family === 'IPv4' && isProxyFakeIpIPv4Address(addr.address))) {
        continue
      }
      if (
        addr.family !== 'IPv4' &&
        !(addr.family === 'IPv6' && isUsableIPv6Address(addr.address))
      ) {
        continue
      }
      if (!listenerServesFamily(listenerHost, addr.family)) {
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
  return (address.includes(':') ? 2 : 1) + bridgePenalty
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
