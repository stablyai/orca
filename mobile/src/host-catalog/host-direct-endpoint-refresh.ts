import { isTailscaleEndpoint } from '../../../src/shared/remote-runtime/remote-runtime-tailscale-hint'
import type { StoredHostProfile } from './host-profile'

const NO_CANDIDATES: readonly string[] = []

export type HostDirectEndpointFields = Pick<StoredHostProfile, 'endpoint' | 'directEndpointOrigin'>

/** A saved endpoint becomes the desktop's to move once the desktop lists it as one of its own addresses. */
export function directEndpointListedByHost(
  row: HostDirectEndpointFields,
  endpoints: readonly string[]
): boolean {
  return row.directEndpointOrigin === undefined && endpoints.includes(row.endpoint)
}

/**
 * Where to try the desktop, in order, when it no longer lists a saved endpoint it once listed. Only the
 * desktop can say an address is no longer its own; a still-listed endpoint is kept even when it prefers
 * another. Candidates are dialed, never saved, until the phone authenticates at one: an address that
 * left for a moment (Wi-Fi reconnect, Tailscale restart) must not strand the row elsewhere.
 */
export function directEndpointCandidates(
  row: HostDirectEndpointFields,
  endpoints: readonly string[]
): readonly string[] {
  if (
    row.directEndpointOrigin !== 'host' ||
    endpoints.length === 0 ||
    endpoints.includes(row.endpoint)
  ) {
    return NO_CANDIDATES
  }
  // Never cross LAN and Tailscale: one can be unreachable from wherever the phone goes next.
  const tailscale = isTailscaleEndpoint(row.endpoint)
  // On a multi-homed desktop, the address nearest the old one (a DHCP move stays in its subnet) is
  // the one this phone most likely reaches; the stable sort keeps the desktop's order on ties.
  // The same address on two interfaces is one dial.
  return [...new Set(endpoints)]
    .filter((candidate) => isTailscaleEndpoint(candidate) === tailscale)
    .map((candidate) => ({ candidate, shared: sharedAddressSegments(row.endpoint, candidate) }))
    .sort((a, b) => b.shared - a.shared)
    .map(({ candidate }) => candidate)
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
