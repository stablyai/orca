import { lookup, type LookupAddress } from 'node:dns'
import { BlockList, isIP, type LookupFunction } from 'node:net'

const BLOCKED_ADDRESSES = new BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4]
] as const) {
  BLOCKED_ADDRESSES.addSubnet(network, prefix, 'ipv4')
}
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8]
] as const) {
  BLOCKED_ADDRESSES.addSubnet(network, prefix, 'ipv6')
}

// IPv4-mapped, IPv4-compatible, SIIT and NAT64 addresses reach the IPv4 in their last 32 bits.
const IPV4_CARRYING_ADDRESSES = new BlockList()
for (const network of ['::ffff:0:0', '::', '::ffff:0:0:0', '64:ff9b::']) {
  IPV4_CARRYING_ADDRESSES.addSubnet(network, 96, 'ipv6')
}

const BLOCKED_NAME_SUFFIXES = ['.localhost', '.internal', '.local']

export function isBlockedAddress(address: string): boolean {
  const bare = address.split('%')[0]
  const family = isIP(bare)
  if (family === 4) {
    return BLOCKED_ADDRESSES.check(bare, 'ipv4')
  }
  if (family !== 6) {
    return true
  }
  if (BLOCKED_ADDRESSES.check(bare, 'ipv6')) {
    return true
  }
  return (
    IPV4_CARRYING_ADDRESSES.check(bare, 'ipv6') &&
    BLOCKED_ADDRESSES.check(embeddedIpv4(bare), 'ipv4')
  )
}

function embeddedIpv4(ipv6: string): string {
  const groups = ipv6Groups(ipv6)
  return [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join('.')
}

function ipv6Groups(ipv6: string): number[] {
  const hex = ipv6.replace(
    /(\d+)\.(\d+)\.(\d+)\.(\d+)$/,
    (_match, a: string, b: string, c: string, d: string) =>
      `${((Number(a) << 8) | Number(b)).toString(16)}:${((Number(c) << 8) | Number(d)).toString(16)}`
  )
  const [head, tail] = hex.split('::')
  const left = head ? head.split(':') : []
  const right = tail ? tail.split(':') : []
  const gap = tail === undefined ? [] : Array<string>(8 - left.length - right.length).fill('0')
  return [...left, ...gap, ...right].map((group) => Number.parseInt(group, 16))
}

/** URL hostnames keep IPv6 brackets and a trailing root dot; both are stripped before checking. */
export function isBlockedHost(hostname: string): boolean {
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
  if (!host || host === 'localhost' || BLOCKED_NAME_SUFFIXES.some((s) => host.endsWith(s))) {
    return true
  }
  return isIP(host.split('%')[0]) !== 0 && isBlockedAddress(host)
}

/** An http(s) URL without credentials whose host is not an internal name or address. */
export function linkPreviewTarget(raw: string, base?: URL): URL | null {
  let url: URL
  try {
    url = new URL(raw, base)
  } catch {
    return null
  }
  const http = url.protocol === 'http:' || url.protocol === 'https:'
  return http && !url.username && !url.password && !isBlockedHost(url.hostname) ? url : null
}

/** Refuses the connection when any resolved address is internal, so DNS rebinding cannot pick one. */
export const guardedLookup: LookupFunction = (hostname, options, callback) => {
  lookup(hostname, { ...options, all: true }, (error, addresses: LookupAddress[]) => {
    if (error) {
      callback(error, '')
      return
    }
    if (
      isBlockedHost(hostname) ||
      addresses.length === 0 ||
      addresses.some(({ address }) => isBlockedAddress(address))
    ) {
      callback(
        Object.assign(new Error(`Link preview refused internal host ${hostname}`), {
          code: 'ERR_LINK_PREVIEW_BLOCKED_ADDRESS'
        }),
        ''
      )
      return
    }
    if (options.all) {
      callback(null, addresses)
    } else {
      callback(null, addresses[0].address, addresses[0].family)
    }
  })
}
