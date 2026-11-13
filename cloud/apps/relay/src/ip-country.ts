// Country of a director request, from an offline IP → country table loaded at boot. Only the
// country (ISO 3166 alpha-2) leaves this module; addresses are never logged or kept.
import { readFileSync } from 'node:fs'
import { isIPv4, isIPv6 } from 'node:net'
import { gunzipSync } from 'node:zlib'

export type IpCountryLookup = {
  // Undefined when the address is not in the table (or is reserved).
  country(ip: string): string | undefined
}

// The client address of a request that reached the director straight through Cloud Run's front
// end (a domain mapping, no load balancer and no proxy in front): the front end appends the peer
// it accepted the connection from to X-Forwarded-For, so the last entry is the client and every
// earlier one is whatever the client sent (forgeable). `trustedProxyHops` skips proxies of ours
// appended after it (1 behind an external load balancer). Undefined when there is no such hop.
export function forwardedClientIp(header: string | undefined, trustedProxyHops = 0): string | undefined {
  const hops = (header ?? '')
    .split(',')
    .map((hop) => hop.trim())
    .filter((hop) => hop.length > 0)
  const client = hops[hops.length - 1 - trustedProxyHops]
  return client !== undefined && (isIPv4(client) || isIPv6(client)) ? client : undefined
}

// The ask's country: null when unknown (no table, no usable hop, or not in the table).
export function requestCountry(
  lookup: IpCountryLookup | undefined,
  forwardedFor: string | undefined
): string | null {
  const ip = lookup ? forwardedClientIp(forwardedFor) : undefined
  return (ip !== undefined && lookup?.country(ip)) || null
}

// Codes the table uses for unallocated or reserved space.
const UNKNOWN_CODES = new Set(['ZZ', 'XX', '--'])

// A table of address ranges, one per line `first,last,CC[,...]` (IPv4 or IPv6, inclusive), as in
// the country-only CSV releases of common IP geolocation databases; `.gz` is read gunzipped.
// IPv6 ranges are kept to their first 64 bits (country data is allocated far coarser than /64).
// Throws on an unreadable file or a table with no ranges, so a misconfigured revision fails to boot
// rather than serving with every country unknown.
export function loadIpCountryTable(path: string): IpCountryLookup {
  const raw = readFileSync(path)
  return parseIpCountryTable((path.endsWith('.gz') ? gunzipSync(raw) : raw).toString('utf8'))
}

export function parseIpCountryTable(text: string): IpCountryLookup {
  const codes: string[] = []
  const codeIndex = new Map<string, number>()
  const v4: [number, number, number][] = []
  const v6: [bigint, bigint, number][] = []
  for (const line of text.split('\n')) {
    const [first, last, rawCode] = line.split(',').map((field) => field.trim().replace(/^"|"$/g, ''))
    const code = rawCode?.toUpperCase()
    if (!first || !last || !code || !/^[A-Z]{2}$/.test(code) || UNKNOWN_CODES.has(code)) {
      continue
    }
    let index = codeIndex.get(code)
    if (index === undefined) {
      index = codes.push(code) - 1
      codeIndex.set(code, index)
    }
    if (isIPv4(first) && isIPv4(last)) {
      v4.push([ipv4Number(first), ipv4Number(last), index])
    } else if (isIPv6(first) && isIPv6(last)) {
      v6.push([ipv6Prefix64(ipv6Groups(first)), ipv6Prefix64(ipv6Groups(last)), index])
    }
  }
  if (v4.length + v6.length === 0) {
    throw new Error('ip_country_table_empty')
  }
  v4.sort((a, b) => a[0] - b[0])
  v6.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  const v4First = Uint32Array.from(v4, (range) => range[0])
  const v4Last = Uint32Array.from(v4, (range) => range[1])
  const v4Code = Uint16Array.from(v4, (range) => range[2])
  const v6First = BigUint64Array.from(v6, (range) => range[0])
  const v6Last = BigUint64Array.from(v6, (range) => range[1])
  const v6Code = Uint16Array.from(v6, (range) => range[2])
  return {
    country(ip) {
      let v4 = isIPv4(ip) ? ipv4Number(ip) : undefined
      let groups: number[] | undefined
      if (v4 === undefined) {
        if (!isIPv6(ip)) {
          return undefined
        }
        groups = ipv6Groups(ip)
        // IPv4-mapped (::ffff:a.b.c.d, or its hex spelling ::ffff:abcd:efgh) is the IPv4 address.
        if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
          v4 = groups[6]! * 0x1_0000 + groups[7]!
        }
      }
      if (v4 !== undefined) {
        const at = rangeAt(v4First, v4Last, v4)
        return at === undefined ? undefined : codes[v4Code[at]!]
      }
      const at = rangeAt(v6First, v6Last, ipv6Prefix64(groups!))
      return at === undefined ? undefined : codes[v6Code[at]!]
    }
  }
}

// Index of the last range starting at or below `value`, if it also ends at or above it.
function rangeAt<T extends number | bigint>(
  first: ArrayLike<T>,
  last: ArrayLike<T>,
  value: T
): number | undefined {
  let low = 0
  let high = first.length - 1
  let found = -1
  while (low <= high) {
    const middle = (low + high) >>> 1
    if (first[middle]! <= value) {
      found = middle
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return found >= 0 && last[found]! >= value ? found : undefined
}

function ipv4Number(ip: string): number {
  return ip.split('.').reduce((value, octet) => value * 256 + Number(octet), 0)
}

// The eight 16-bit groups of a valid IPv6 address (a trailing dotted IPv4 part is the last two).
function ipv6Groups(ip: string): number[] {
  const [head = '', tail] = ip.toLowerCase().split('::')
  const tokens = (part: string) =>
    (part ? part.split(':') : []).flatMap((token) =>
      token.includes('.')
        ? [ipv4Number(token) >>> 16, ipv4Number(token) & 0xffff]
        : [Number.parseInt(token, 16)]
    )
  const headGroups = tokens(head)
  if (tail === undefined) {
    return headGroups
  }
  const tailGroups = tokens(tail)
  return [...headGroups, ...Array<number>(8 - headGroups.length - tailGroups.length).fill(0), ...tailGroups]
}

// The first 64 bits (country data is allocated far coarser than /64).
function ipv6Prefix64(groups: number[]): bigint {
  return groups.slice(0, 4).reduce((value, group) => (value << 16n) | BigInt(group), 0n)
}
