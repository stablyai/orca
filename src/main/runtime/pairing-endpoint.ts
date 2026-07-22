import { isIP } from 'node:net'

export const INVALID_PAIRING_ENDPOINT_GUIDANCE =
  'Use a reachable hostname, host:port, IPv4/IPv6 literal, or ws(s):// URL. HTTP(S) URLs are normalized to WebSocket URLs.'

export type PairingEndpointResolution =
  | { ok: true; endpoint: string }
  | {
      ok: false
      reason: 'invalid_advertised_endpoint'
      guidance: string
    }

export function resolveAdvertisedPairingEndpoint(
  boundEndpoint: string,
  advertisedAddress: string | null | undefined
): PairingEndpointResolution {
  const endpoint = new URL(boundEndpoint)
  const override = advertisedAddress?.trim()
  if (!override) {
    // Why: a wildcard listener is not client-reachable; default pairing must remain local-only unless explicitly advertised.
    endpoint.hostname = '127.0.0.1'
    return valid(formatWebSocketUrl(endpoint))
  }

  if (override.includes('://')) {
    return resolveFullUrl(override)
  }

  const parsed = parseHostOverride(override)
  if (!parsed || isWildcardHost(parsed.hostname)) {
    return invalid()
  }
  endpoint.hostname = bracketIpv6(parsed.hostname)
  if (parsed.port) {
    endpoint.port = parsed.port
  }
  return valid(formatWebSocketUrl(endpoint))
}

function resolveFullUrl(value: string): PairingEndpointResolution {
  let endpoint: URL
  try {
    endpoint = new URL(value)
  } catch {
    return invalid()
  }
  if (endpoint.protocol === 'http:') {
    endpoint.protocol = 'ws:'
  } else if (endpoint.protocol === 'https:') {
    endpoint.protocol = 'wss:'
  }
  if (
    (endpoint.protocol !== 'ws:' && endpoint.protocol !== 'wss:') ||
    !endpoint.hostname ||
    endpoint.username ||
    endpoint.password ||
    endpoint.hash ||
    endpoint.port === '0' ||
    isWildcardHost(endpoint.hostname)
  ) {
    return invalid()
  }
  return valid(formatWebSocketUrl(endpoint))
}

function parseHostOverride(value: string): { hostname: string; port: string } | null {
  try {
    const rawIpVersion = isIP(value)
    const explicitPort = rawIpVersion === 6 ? null : getExplicitPort(value)
    // Why: port zero is a bind-time request, not an endpoint a remote client can dial.
    if (explicitPort === '0') {
      return null
    }
    if (rawIpVersion !== 6 && value.endsWith(':')) {
      return null
    }
    const url = new URL(rawIpVersion === 6 ? `ws://[${value}]` : `ws://${value}`)
    if (
      !url.hostname ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    ) {
      return null
    }
    return { hostname: unbracketIpv6(url.hostname), port: explicitPort ?? url.port }
  } catch {
    return null
  }
}

function getExplicitPort(value: string): string | null {
  const match = value.startsWith('[') ? value.match(/^\[[^\]]+\]:(\d+)$/) : value.match(/:(\d+)$/)
  return match?.[1] ?? null
}

function isWildcardHost(hostname: string): boolean {
  const normalized = unbracketIpv6(hostname).toLowerCase()
  // Why: wildcard bind addresses identify local interfaces, not a route a client can connect to.
  return normalized === '*' || normalized === '0.0.0.0' || normalized === '::'
}

function bracketIpv6(hostname: string): string {
  const normalized = unbracketIpv6(hostname)
  return normalized.includes(':') ? `[${normalized}]` : normalized
}

function unbracketIpv6(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, '')
}

function formatWebSocketUrl(url: URL): string {
  const formatted = url.toString()
  return url.pathname === '/' && !url.search && !url.hash ? formatted.replace(/\/$/, '') : formatted
}

function valid(endpoint: string): PairingEndpointResolution {
  return { ok: true, endpoint }
}

function invalid(): PairingEndpointResolution {
  return {
    ok: false,
    reason: 'invalid_advertised_endpoint',
    guidance: INVALID_PAIRING_ENDPOINT_GUIDANCE
  }
}
