import { isIP } from 'node:net'
import { networkInterfaces } from 'node:os'
import {
  isVirtualBridgeInterface,
  selectAutoAdvertisedPairingAddress
} from '../../../../../../shared/pairing-address-auto-selection'
import { isLinkLocalAddress } from '../../../../../../shared/network/link-local-address'
import { isTailnetIPv4Address } from '../../../../../../shared/tailnet-address'
import { getWindowsDefaultRouteInterfaceNames } from './windows-default-route-interfaces'

export type NetworkInterface = {
  name: string
  address: string
  hasDefaultRoute?: boolean
}

export type DefaultRouteInterfaceLookup = () => Promise<ReadonlySet<string> | null>

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
        isLinkLocalAddress(addr.address)
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
