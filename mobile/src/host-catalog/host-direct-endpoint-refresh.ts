import { isTailscaleEndpoint } from '../../../src/shared/remote-runtime/remote-runtime-tailscale-hint'
import type { StoredHostProfile } from './host-profile'

/**
 * Apply the desktop's current direct endpoints to a saved row. Only the desktop can say an address is
 * no longer its own, so a stored endpoint it still lists is kept even when it prefers another one.
 */
export function withHostDirectEndpoints(
  host: StoredHostProfile,
  endpoints: readonly string[]
): StoredHostProfile {
  if (endpoints.length === 0 || host.directEndpointOrigin === 'manual') {
    return host
  }
  if (endpoints.includes(host.endpoint)) {
    return host.directEndpointOrigin === 'host' ? host : { ...host, directEndpointOrigin: 'host' }
  }
  // An unknown origin may be a tunnel or a value typed before origins were recorded.
  if (host.directEndpointOrigin !== 'host') {
    return host
  }
  // Prefer the kind of network this phone reached it on: a Tailscale address the phone lacks would strand it.
  const tailscale = isTailscaleEndpoint(host.endpoint)
  const endpoint =
    endpoints.find((candidate) => isTailscaleEndpoint(candidate) === tailscale) ?? endpoints[0]!
  return { ...host, endpoint }
}
