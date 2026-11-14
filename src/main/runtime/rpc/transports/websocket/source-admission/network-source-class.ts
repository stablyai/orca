// Where a direct runtime client connects from, judged by the TCP peer address alone.
import { BlockList, isIP } from 'node:net'

export const NETWORK_SOURCE_CLASSES = ['loopback', 'private', 'tailnet', 'public'] as const
export type NetworkSourceClass = (typeof NETWORK_SOURCE_CLASSES)[number]

const LOOPBACK = new BlockList()
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4')
LOOPBACK.addAddress('::1', 'ipv6')

// Tailscale's ULA prefix sits inside fc00::/7, so tailnet is checked before private.
const TAILNET = new BlockList()
TAILNET.addSubnet('100.64.0.0', 10, 'ipv4')
TAILNET.addSubnet('fd7a:115c:a1e0::', 48, 'ipv6')

const PRIVATE = new BlockList()
for (const [network, prefix] of [
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['169.254.0.0', 16]
] as const) {
  PRIVATE.addSubnet(network, prefix, 'ipv4')
}
PRIVATE.addSubnet('fc00::', 7, 'ipv6')
PRIVATE.addSubnet('fe80::', 10, 'ipv6')

/** Dual-stack listeners report IPv4 peers as `::ffff:a.b.c.d`; link-local peers may carry a zone. */
export function normalizeSourceAddress(address: string | undefined): string | null {
  if (!address) {
    return null
  }
  const bare = address.split('%')[0]!.toLowerCase()
  const mapped = bare.startsWith('::ffff:') ? bare.slice(7) : null
  const unmapped = mapped !== null && isIP(mapped) === 4 ? mapped : bare
  return isIP(unmapped) === 0 ? null : unmapped
}

/** Null for a peer without a usable address (the socket already closed). */
export function classifyNetworkSource(rawAddress: string | undefined): NetworkSourceClass | null {
  const address = normalizeSourceAddress(rawAddress)
  if (address === null) {
    return null
  }
  const type = isIP(address) === 6 ? 'ipv6' : 'ipv4'
  if (LOOPBACK.check(address, type)) {
    return 'loopback'
  }
  if (TAILNET.check(address, type)) {
    return 'tailnet'
  }
  return PRIVATE.check(address, type) ? 'private' : 'public'
}

/** One IPv4 host, or one IPv6 /64 (a single site usually holds a whole /64). */
export function networkSourceKey(rawAddress: string | undefined): string | null {
  const address = normalizeSourceAddress(rawAddress)
  if (address === null || isIP(address) === 4) {
    return address
  }
  return `${ipv6Groups(address).slice(0, 4).join(':')}::/64`
}

function ipv6Groups(ipv6: string): string[] {
  // An embedded IPv4 tail fills the last two groups.
  const hex = ipv6.replace(
    /(\d+)\.(\d+)\.(\d+)\.(\d+)$/,
    (_m, a: string, b: string, c: string, d: string) =>
      [
        ((Number(a) << 8) | Number(b)).toString(16),
        ((Number(c) << 8) | Number(d)).toString(16)
      ].join(':')
  )
  const [head = '', tail] = hex.split('::')
  const left = head ? head.split(':') : []
  const right = tail ? tail.split(':') : []
  const gap = tail === undefined ? [] : Array<string>(8 - left.length - right.length).fill('0')
  return [...left, ...gap, ...right].map((group) => Number.parseInt(group, 16).toString(16))
}
