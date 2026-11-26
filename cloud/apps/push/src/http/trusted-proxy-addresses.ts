import { isIP } from 'node:net'

const IPV4_MAPPED = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/
const CIDR = /^([^/]+)\/(0|[1-9][0-9]{0,2})$/

export type TrustedProxyRange = { family: 4 | 6; network: bigint; prefix: number; text: string }

export type TrustedProxy =
  | { kind: 'address'; address: string }
  | { kind: 'range'; range: TrustedProxyRange }

export type TrustedProxyParse = { ok: true; proxy: TrustedProxy } | { ok: false; reason: string }

// One spelling per address, so 2001:0DB8::000A in config matches 2001:db8::a in a header and
// ::ffff:203.0.113.10 matches 203.0.113.10.
export function canonicalIp(address: string): string {
  if (isIP(address) !== 6) return address.toLowerCase()
  const compressed = compressIpv6(address)
  if (compressed === null) return address.toLowerCase()
  const mapped = IPV4_MAPPED.exec(compressed)
  if (!mapped) return compressed
  const high = Number.parseInt(mapped[1]!, 16)
  const low = Number.parseInt(mapped[2]!, 16)
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.')
}

/** Accepts one address (203.0.113.10) or a network (2600:1901:0:1234::/64); anything else is refused. */
export function parseTrustedProxy(entry: string): TrustedProxyParse {
  if (entry.includes('%')) return { ok: false, reason: 'zone-scoped addresses are not supported' }
  const cidr = CIDR.exec(entry)
  if (!cidr) {
    if (entry.includes('/')) return { ok: false, reason: 'expected <address>/<prefix length>' }
    if (isIP(entry) === 0) return { ok: false, reason: 'not an IP address or CIDR range' }
    return { ok: true, proxy: { kind: 'address', address: canonicalIp(entry) } }
  }
  const family = isIP(cidr[1]!)
  if (family !== 4 && family !== 6)
    return { ok: false, reason: 'range does not start with an IP address' }
  const bits = family === 4 ? 32 : 128
  const prefix = Number(cidr[2])
  // A /0 trusts every hop, so the forgeable leftmost entry would pick the bucket.
  if (prefix < 1 || prefix > bits) {
    return { ok: false, reason: `prefix length must be 1 to ${bits}` }
  }
  const value = ipToBigInt(family, cidr[1]!)
  if (value === null) return { ok: false, reason: 'range does not start with an IP address' }
  const network = maskTo(value, prefix, bits)
  const text = `${formatIp(family, network)}/${prefix}`
  if (network !== value) return { ok: false, reason: `host bits are set; use ${text}` }
  return { ok: true, proxy: { kind: 'range', range: { family, network, prefix, text } } }
}

export function rangeContains(range: TrustedProxyRange, address: string): boolean {
  const family = isIP(address)
  if (family !== range.family) return false
  const value = ipToBigInt(family, address)
  const bits = family === 4 ? 32 : 128
  return value !== null && maskTo(value, range.prefix, bits) === range.network
}

function maskTo(value: bigint, prefix: number, bits: number): bigint {
  const hostBits = BigInt(bits - prefix)
  return (value >> hostBits) << hostBits
}

function compressIpv6(address: string): string | null {
  try {
    return new URL(`http://[${address}]`).hostname.slice(1, -1)
  } catch {
    return null
  }
}

function ipToBigInt(family: 4 | 6, address: string): bigint | null {
  if (family === 4) {
    return address.split('.').reduce((value, octet) => (value << 8n) | BigInt(Number(octet)), 0n)
  }
  // The URL form is plain hex groups with at most one "::", even for embedded IPv4.
  const compressed = compressIpv6(address)
  if (compressed === null) return null
  const [head = '', tail] = compressed.split('::')
  const headGroups = head === '' ? [] : head.split(':')
  const tailGroups = tail === undefined || tail === '' ? [] : tail.split(':')
  const groups =
    tail === undefined
      ? headGroups
      : [
          ...headGroups,
          ...Array<string>(8 - headGroups.length - tailGroups.length).fill('0'),
          ...tailGroups
        ]
  return groups.reduce((value, group) => (value << 16n) | BigInt(Number.parseInt(group, 16)), 0n)
}

function formatIp(family: 4 | 6, value: bigint): string {
  if (family === 4) {
    return [24n, 16n, 8n, 0n].map((shift) => String((value >> shift) & 0xffn)).join('.')
  }
  const groups = [112n, 96n, 80n, 64n, 48n, 32n, 16n, 0n].map((shift) =>
    ((value >> shift) & 0xffffn).toString(16)
  )
  return compressIpv6(groups.join(':')) ?? groups.join(':')
}
