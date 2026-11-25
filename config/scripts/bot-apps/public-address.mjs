import { BlockList, isIP } from 'node:net'

// Ranges that are not reachable public internet (RFC 6890 special-purpose registries).
const NON_PUBLIC_V4 = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4]
]

const NON_PUBLIC_V6 = [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8]
]

// BlockList matches IPv4-mapped IPv6 (::ffff:a.b.c.d) against the IPv4 rules itself.
const nonPublic = new BlockList()
for (const [net, prefix] of NON_PUBLIC_V4) {
  nonPublic.addSubnet(net, prefix, 'ipv4')
}
for (const [net, prefix] of NON_PUBLIC_V6) {
  nonPublic.addSubnet(net, prefix, 'ipv6')
}

export function isPublicAddress(address) {
  const version = isIP(address)
  if (version === 0) {
    return false
  }
  return !nonPublic.check(address, version === 4 ? 'ipv4' : 'ipv6')
}

/** A URL hostname that is itself an IP literal, without IPv6 brackets; null for DNS names. */
export function ipLiteralOf(hostname) {
  const bare = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname
  return isIP(bare) === 0 ? null : bare
}
