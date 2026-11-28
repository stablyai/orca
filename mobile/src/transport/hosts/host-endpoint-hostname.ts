import type { Translate } from '../../i18n/mobile-i18n'
import { hostEndpointCopy } from './host-endpoint-copy'

const NUMERIC_IPV4_CANDIDATE = /^(?:0[xX][0-9a-fA-F]+|\d+)(?:\.(?:0[xX][0-9a-fA-F]+|\d+))*$/

export function validateHostname(host: string, t: Translate): string | null {
  if (!host) {
    return hostEndpointCopy.hostnameRequired(t)
  }
  if (/[\s/?#@[\]]/.test(host)) {
    return hostEndpointCopy.invalidHostname(t)
  }
  const numericIpv4Error = validateNumericIpv4Candidate(host, t)
  if (numericIpv4Error) {
    return numericIpv4Error
  }
  if (host.includes(':')) {
    // Use the WebSocket URL parser to reject malformed IPv6 that a hex/colon regex accepts.
    if (!/^[0-9a-fA-F:]+$/.test(host)) {
      return hostEndpointCopy.invalidHostname(t)
    }
    try {
      new URL(`ws://[${host}]`)
    } catch {
      return hostEndpointCopy.invalidHostname(t)
    }
    return null
  }
  if (
    !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/.test(
      host
    )
  ) {
    return hostEndpointCopy.invalidHostname(t)
  }
  return null
}

export function validateNumericIpv4Candidate(host: string, t: Translate): string | null {
  if (!NUMERIC_IPV4_CANDIDATE.test(host)) {
    return null
  }
  if (!isCanonicalIpv4(host)) {
    return hostEndpointCopy.invalidHostname(t)
  }
  return null
}

export function isCanonicalIpv4(host: string): boolean {
  const octets = host.split('.')
  return (
    octets.length === 4 &&
    octets.every((octet) => /^(?:0|[1-9]\d{0,2})$/.test(octet) && Number(octet) <= 255)
  )
}
