// Which peers may open a TCP connection to the runtime WebSocket listener (`orca serve --allow-ip`).
import { BlockList, isIP } from 'node:net'

export class AllowedClientRangeError extends Error {
  readonly code = 'invalid_allowed_client_range'
}

/** A dual-stack listener reports IPv4 peers as `::ffff:a.b.c.d`; match them as plain IPv4. */
export function normalizeClientAddress(address: string | undefined): string | null {
  if (!address) {
    return null
  }
  const mapped = address.toLowerCase().startsWith('::ffff:') ? address.slice(7) : null
  const unmapped = mapped !== null && isIP(mapped) === 4 ? mapped : address
  return isIP(unmapped) === 0 ? null : unmapped
}

export function isLoopbackClientAddress(address: string): boolean {
  return address === '::1' || (isIP(address) === 4 && address.startsWith('127.'))
}

/** Comma-separated IPs and CIDR ranges, as `--allow-ip` takes them. */
export function parseAllowedClientRanges(raw: string): string[] {
  const ranges = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
  if (ranges.length === 0) {
    throw new AllowedClientRangeError('--allow-ip expects at least one IP address or CIDR range')
  }
  createAllowedClientList(ranges)
  return ranges
}

export function createAllowedClientList(ranges: readonly string[]): BlockList {
  const list = new BlockList()
  for (const range of ranges) {
    const [address = '', prefix, extra] = range.split('/')
    const version = isIP(address)
    if (version === 0 || extra !== undefined) {
      throw invalidRange(range)
    }
    const type = version === 6 ? 'ipv6' : 'ipv4'
    if (prefix === undefined) {
      list.addAddress(address, type)
      continue
    }
    const bits = Number(prefix)
    if (!/^\d+$/.test(prefix) || bits > (version === 6 ? 128 : 32)) {
      throw invalidRange(range)
    }
    list.addSubnet(address, bits, type)
  }
  return list
}

/**
 * Loopback always passes: only processes on this machine can use it, and an SSH local
 * port-forward (the documented way to reach a remote server) arrives from loopback.
 */
export function isClientAddressAllowed(list: BlockList, rawAddress: string | undefined): boolean {
  const address = normalizeClientAddress(rawAddress)
  if (address === null) {
    return false
  }
  if (isLoopbackClientAddress(address)) {
    return true
  }
  return list.check(address, isIP(address) === 6 ? 'ipv6' : 'ipv4')
}

function invalidRange(range: string): AllowedClientRangeError {
  return new AllowedClientRangeError(
    `--allow-ip expects IP addresses or CIDR ranges such as 203.0.113.7 or 100.64.0.0/10 (got '${range}')`
  )
}
