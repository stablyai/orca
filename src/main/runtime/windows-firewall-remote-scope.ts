type IpVersion = 4 | 6

type ParsedIpAddress = {
  version: IpVersion
  bits: 32 | 128
  value: bigint
}

type IpRange = {
  version: IpVersion
  start: bigint
  end: bigint
}

export function hasSufficientWindowsFirewallRemoteScope(
  ruleScopes: unknown,
  localAddress: unknown,
  localPrefixLength: unknown
): boolean {
  const rules = Array.isArray(ruleScopes) ? ruleScopes : [ruleScopes]
  const localSubnet = parseSubnet(localAddress, localPrefixLength)

  // Why: coverage is checked per scope, never unioned across rules — this
  // advisory check fails safe, so accepting fragmented rules only adds risk.
  return rules.some((rule) => ruleHasSufficientScope(rule, localSubnet))
}

function ruleHasSufficientScope(rule: unknown, localSubnet: IpRange | null): boolean {
  if (!isRecord(rule)) {
    return false
  }
  const addresses = Array.isArray(rule.remoteAddresses)
    ? rule.remoteAddresses
    : [rule.remoteAddresses]

  return addresses.some(
    (address) => typeof address === 'string' && addressScopeIsSufficient(address, localSubnet)
  )
}

function addressScopeIsSufficient(scope: string, localSubnet: IpRange | null): boolean {
  const normalized = scope.trim().toLowerCase()
  if (normalized === 'any' || normalized === 'localsubnet') {
    return true
  }
  if (
    normalized === 'any4' ||
    normalized === 'any6' ||
    normalized === 'localsubnet4' ||
    normalized === 'localsubnet6'
  ) {
    // Why: these keywords cover a single family, so they need the selected
    // interface's family; an unknown family (null subnet) fails closed.
    return localSubnet?.version === (normalized.endsWith('4') ? 4 : 6)
  }
  if (!localSubnet) {
    return false
  }

  // Why: without a phone IP we can only prove coverage when the rule spans the
  // whole selected subnet; a single-host subnet (/32, /128 VPN/Tailscale) is just
  // the desktop, so start !== end blocks a desktop-only rule from a false-allow.
  const explicitRange = parseIpRange(scope)
  return (
    localSubnet.start !== localSubnet.end &&
    explicitRange?.version === localSubnet.version &&
    explicitRange.start <= localSubnet.start &&
    explicitRange.end >= localSubnet.end
  )
}

function parseSubnet(address: unknown, prefixLength: unknown): IpRange | null {
  if (typeof address !== 'string' || typeof prefixLength !== 'number') {
    return null
  }
  const parsed = parseIpAddress(address)
  return parsed ? subnetFromParsed(parsed, prefixLength) : null
}

function subnetFromParsed(parsed: ParsedIpAddress, prefixLength: number): IpRange | null {
  if (!Number.isInteger(prefixLength) || prefixLength < 0 || prefixLength > parsed.bits) {
    return null
  }
  const hostBits = BigInt(parsed.bits - prefixLength)
  const hostMask = hostBits === 0n ? 0n : (1n << hostBits) - 1n
  const start = parsed.value & ~hostMask
  return { version: parsed.version, start, end: start | hostMask }
}

// Why: Windows also accepts dotted-netmask CIDR (192.168.0.0/255.255.255.0);
// convert a contiguous mask to a prefix length and fail closed on holey masks.
function maskPrefixLength(maskText: string, version: IpVersion): number | null {
  const mask = parseIpAddress(maskText)
  if (!mask || mask.version !== version) {
    return null
  }
  const fullMask = (1n << BigInt(mask.bits)) - 1n
  const hostPart = ~mask.value & fullMask
  if ((hostPart & (hostPart + 1n)) !== 0n) {
    return null
  }
  let hostBits = 0
  for (let remaining = hostPart; remaining > 0n; remaining >>= 1n) {
    hostBits += 1
  }
  return mask.bits - hostBits
}

function parseIpRange(scope: string): IpRange | null {
  const trimmed = scope.trim()
  const dashIndex = trimmed.indexOf('-')
  if (dashIndex >= 0) {
    if (dashIndex !== trimmed.lastIndexOf('-')) {
      return null
    }
    const start = parseIpAddress(trimmed.slice(0, dashIndex))
    const end = parseIpAddress(trimmed.slice(dashIndex + 1))
    if (!start || !end || start.version !== end.version || start.value > end.value) {
      return null
    }
    return { version: start.version, start: start.value, end: end.value }
  }

  const slashIndex = trimmed.indexOf('/')
  if (slashIndex >= 0) {
    if (slashIndex !== trimmed.lastIndexOf('/')) {
      return null
    }
    const address = parseIpAddress(trimmed.slice(0, slashIndex))
    if (!address) {
      return null
    }
    const suffix = trimmed.slice(slashIndex + 1)
    const prefixLength = /^\d+$/.test(suffix)
      ? Number(suffix)
      : maskPrefixLength(suffix, address.version)
    return prefixLength === null ? null : subnetFromParsed(address, prefixLength)
  }

  const address = parseIpAddress(trimmed)
  return address ? { version: address.version, start: address.value, end: address.value } : null
}

function parseIpAddress(input: string): ParsedIpAddress | null {
  const trimmed = input.trim()
  const bracketed = trimmed.startsWith('[') || trimmed.endsWith(']')
  if (bracketed && !(trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    return null
  }
  const address = (bracketed ? trimmed.slice(1, -1) : trimmed).split('%', 1)[0] ?? ''
  return address.includes(':') ? parseIpv6(address) : parseIpv4(address)
}

function parseIpv4(address: string): ParsedIpAddress | null {
  const octets = address.split('.')
  if (octets.length !== 4 || octets.some((octet) => !/^\d{1,3}$/.test(octet))) {
    return null
  }
  const values = octets.map(Number)
  if (values.some((octet) => octet > 255)) {
    return null
  }
  const value = values.reduce((result, octet) => (result << 8n) | BigInt(octet), 0n)
  return { version: 4, bits: 32, value }
}

function parseIpv6(address: string): ParsedIpAddress | null {
  const expandedAddress = expandEmbeddedIpv4(address)
  if (!expandedAddress) {
    return null
  }
  const halves = expandedAddress.split('::')
  if (halves.length > 2) {
    return null
  }
  const left = splitIpv6Half(halves[0] ?? '')
  const right = splitIpv6Half(halves[1] ?? '')
  if (!left || !right) {
    return null
  }

  const hasCompression = halves.length === 2
  const missingGroups = 8 - left.length - right.length
  if ((!hasCompression && missingGroups !== 0) || (hasCompression && missingGroups < 1)) {
    return null
  }
  const groups = [...left, ...Array<string>(missingGroups).fill('0'), ...right]
  const value = groups.reduce((result, group) => (result << 16n) | BigInt(`0x${group}`), 0n)
  return { version: 6, bits: 128, value }
}

function expandEmbeddedIpv4(address: string): string | null {
  if (!address.includes('.')) {
    return address
  }
  const lastColon = address.lastIndexOf(':')
  const ipv4 = parseIpv4(address.slice(lastColon + 1))
  if (lastColon < 0 || !ipv4) {
    return null
  }
  const high = ((ipv4.value >> 16n) & 0xffffn).toString(16)
  const low = (ipv4.value & 0xffffn).toString(16)
  return `${address.slice(0, lastColon)}:${high}:${low}`
}

function splitIpv6Half(half: string): string[] | null {
  if (half === '') {
    return []
  }
  const groups = half.split(':')
  return groups.every((group) => /^[\da-f]{1,4}$/i.test(group)) ? groups : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
