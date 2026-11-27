import { isTailscaleEndpoint } from '../../../src/shared/remote-runtime/remote-runtime-tailscale-hint'
import type { StoredHostProfile } from './host-profile'

export type HostDirectEndpointFields = Pick<StoredHostProfile, 'endpoint' | 'directEndpointOrigin'>

/** A saved endpoint becomes the desktop's to move once the desktop lists it as one of its own addresses. */
export function directEndpointListedByHost(
  row: HostDirectEndpointFields,
  endpoints: readonly string[]
): boolean {
  return row.directEndpointOrigin === undefined && endpoints.includes(row.endpoint)
}

/**
 * Where to try the desktop when it no longer lists a saved endpoint it once listed. Only the desktop can
 * say an address is no longer its own; a still-listed endpoint is kept even when it prefers another.
 * The candidate is dialed, never saved, until the phone authenticates there: an address that left
 * for a moment (Wi-Fi reconnect, Tailscale restart) must not strand the row elsewhere.
 */
export function directEndpointCandidate(
  row: HostDirectEndpointFields,
  endpoints: readonly string[]
): string | null {
  if (row.directEndpointOrigin !== 'host' || endpoints.includes(row.endpoint)) {
    return null
  }
  // Never cross LAN and Tailscale: one can be unreachable from wherever the phone goes next.
  const tailscale = isTailscaleEndpoint(row.endpoint)
  let best: string | null = null
  let bestShared = -1
  for (const candidate of endpoints) {
    // On a multi-homed desktop, the address nearest the old one (a DHCP move stays in its subnet) is
    // the one this phone most likely reaches; ties keep the desktop's preference order.
    const shared = sharedAddressSegments(row.endpoint, candidate)
    if (isTailscaleEndpoint(candidate) === tailscale && shared > bestShared) {
      best = candidate
      bestShared = shared
    }
  }
  return best
}

function sharedAddressSegments(a: string, b: string): number {
  const segments = (endpoint: string): string[] => {
    try {
      return new URL(endpoint).hostname.replace(/^\[|\]$/g, '').split(/[.:]/)
    } catch {
      return []
    }
  }
  const left = segments(a)
  const right = segments(b)
  let shared = 0
  while (shared < left.length && left[shared] === right[shared]) {
    shared += 1
  }
  return shared
}
