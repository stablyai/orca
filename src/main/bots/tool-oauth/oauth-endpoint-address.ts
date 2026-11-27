// Whether an OAuth endpoint's address is on the public internet, so an app on the public internet
// can't point Orca's token requests into the user's own network.
import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'

/** Every address a host name resolves to; tests inject their own. */
export type AddressLookup = (hostname: string) => Promise<readonly string[]>

export const systemAddressLookup: AddressLookup = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map((answer) => answer.address)

// IANA special-purpose ranges (RFC 6890 and its updates) a public service never answers from.
const NOT_PUBLIC = new BlockList()
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
  NOT_PUBLIC.addSubnet(network, prefix, 'ipv4')
}
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8]
] as const) {
  NOT_PUBLIC.addSubnet(network, prefix, 'ipv6')
}

/** An IPv4 address carried inside IPv6 (`::ffff:a.b.c.d`), as its IPv4 form. */
function mappedIpv4(address: string): string | null {
  const match = /^::ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/i.exec(address)
  if (!match) {
    return null
  }
  if (match[1]) {
    return match[1]
  }
  const high = Number.parseInt(match[2]!, 16)
  const low = Number.parseInt(match[3]!, 16)
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.')
}

/** Whether `address` is a public IP address; anything that isn't an IP address is not. */
export function isPublicAddress(address: string): boolean {
  const bare = address.replace(/^\[(.*)\]$/, '$1').split('%')[0] ?? ''
  const version = isIP(bare)
  if (version === 0) {
    return false
  }
  const v4 = version === 6 ? mappedIpv4(bare.toLowerCase()) : bare
  if (v4 && isIP(v4) === 4) {
    return !NOT_PUBLIC.check(v4, 'ipv4')
  }
  return !NOT_PUBLIC.check(bare, 'ipv6')
}

/** The addresses a URL's host stands for: itself when it's an IP address, else what it resolves to. */
export async function hostAddresses(url: URL, resolve: AddressLookup): Promise<readonly string[]> {
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1')
  return isIP(host) ? [host] : await resolve(host)
}
