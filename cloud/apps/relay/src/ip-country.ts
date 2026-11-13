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
  return parseIpCountryBytes(path.endsWith('.gz') ? gunzipSync(raw) : raw)
}

export function parseIpCountryTable(text: string): IpCountryLookup {
  return parseIpCountryBytes(Buffer.from(text, 'utf8'))
}

const NEWLINE = 0x0a
const COMMA = 0x2c

// Parses the bytes straight into typed arrays, a line at a time. Only a line's first three fields
// become strings, and none outlives its line: a 30 MB table never exists as one string, a string
// per line or an array per range, so the boot peak stays near the file size.
function parseIpCountryBytes(bytes: Buffer): IpCountryLookup {
  let lines = 1
  for (let at = bytes.indexOf(NEWLINE); at !== -1; at = bytes.indexOf(NEWLINE, at + 1)) {
    lines += 1
  }
  const codes: string[] = []
  const codeIndex = new Map<string, number>()
  // Sized for every line in one family, then trimmed to what was read.
  const v4First = new Uint32Array(lines)
  const v4Last = new Uint32Array(lines)
  const v4Code = new Uint16Array(lines)
  const v6First = new BigUint64Array(lines)
  const v6Last = new BigUint64Array(lines)
  const v6Code = new Uint16Array(lines)
  let v4Count = 0
  let v6Count = 0
  const field = (from: number, to: number) =>
    bytes.toString('utf8', from, to).trim().replace(/^"|"$/g, '')
  for (let start = 0; start < bytes.length; ) {
    const newline = bytes.indexOf(NEWLINE, start)
    const end = newline === -1 ? bytes.length : newline
    const lineStart = start
    start = end + 1
    // The line's first three comma-separated fields; the third ends at a comma or the line end.
    const firstComma = bytes.indexOf(COMMA, lineStart)
    if (firstComma === -1 || firstComma >= end) {
      continue
    }
    const secondComma = bytes.indexOf(COMMA, firstComma + 1)
    if (secondComma === -1 || secondComma >= end) {
      continue
    }
    const thirdComma = bytes.indexOf(COMMA, secondComma + 1)
    const codeEnd = thirdComma === -1 || thirdComma > end ? end : thirdComma
    const code = field(secondComma + 1, codeEnd).toUpperCase()
    if (!/^[A-Z]{2}$/.test(code) || UNKNOWN_CODES.has(code)) {
      continue
    }
    const first = field(lineStart, firstComma)
    const last = field(firstComma + 1, secondComma)
    if (!first || !last) {
      continue
    }
    let index = codeIndex.get(code)
    if (index === undefined) {
      index = codes.push(code) - 1
      codeIndex.set(code, index)
    }
    if (isIPv4(first) && isIPv4(last)) {
      v4First[v4Count] = ipv4Number(first)
      v4Last[v4Count] = ipv4Number(last)
      v4Code[v4Count] = index
      v4Count += 1
    } else if (isIPv6(first) && isIPv6(last)) {
      v6First[v6Count] = ipv6Prefix64(ipv6Groups(first))
      v6Last[v6Count] = ipv6Prefix64(ipv6Groups(last))
      v6Code[v6Count] = index
      v6Count += 1
    }
  }
  if (v4Count + v6Count === 0) {
    throw new Error('ip_country_table_empty')
  }
  const v4 = byFirst(v4First, v4Last, v4Code, v4Count)
  const v6 = byFirst(v6First, v6Last, v6Code, v6Count)
  return lookup(codes, v4, v6)
}

type Ranges<T extends Uint32Array | BigUint64Array> = { first: T; last: T; code: Uint16Array }

// The first `count` ranges, ordered by first address; ties keep file order (a stable sort), so
// the later of two ranges with the same start wins, as it always has. Release files are already
// in order, which costs one pass and no sort.
function byFirst<T extends Uint32Array | BigUint64Array>(
  first: T,
  last: T,
  code: Uint16Array,
  count: number
): Ranges<T> {
  let sorted = true
  for (let at = 1; at < count && sorted; at += 1) {
    sorted = first[at - 1]! <= first[at]!
  }
  if (sorted) {
    return {
      first: first.slice(0, count) as T,
      last: last.slice(0, count) as T,
      code: code.slice(0, count)
    }
  }
  const order = new Uint32Array(count)
  for (let at = 0; at < count; at += 1) {
    order[at] = at
  }
  order.sort((a, b) => (first[a]! < first[b]! ? -1 : first[a]! > first[b]! ? 1 : a - b))
  const result = {
    first: first.slice(0, count) as T,
    last: last.slice(0, count) as T,
    code: new Uint16Array(count)
  }
  for (let at = 0; at < count; at += 1) {
    const from = order[at]!
    result.first[at] = first[from]!
    result.last[at] = last[from]!
    result.code[at] = code[from]!
  }
  return result
}

function lookup(
  codes: string[],
  { first: v4First, last: v4Last, code: v4Code }: Ranges<Uint32Array>,
  { first: v6First, last: v6Last, code: v6Code }: Ranges<BigUint64Array>
): IpCountryLookup {
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
