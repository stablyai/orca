import type { HostDirectEndpointFields } from './host-direct-endpoint-refresh'

// Saved direct endpoints belong to the native endpoint lifecycle, which the page does not run.
export function markHostDirectEndpointListed(
  _hostId: string,
  _endpoints: readonly string[]
): Promise<HostDirectEndpointFields | null> {
  return Promise.resolve(null)
}

export function adoptHostDirectEndpoint(
  _hostId: string,
  _replaced: string,
  _endpoint: string
): Promise<HostDirectEndpointFields | null> {
  return Promise.resolve(null)
}
