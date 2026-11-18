export type BrowserClientNetworkRouteAddress = { host: string; port: number }

/** A route's SOCKS listener is loopback-only; anything else would expose the tunnel to the LAN. */
export function assertBrowserClientNetworkRouteAddress(
  address: BrowserClientNetworkRouteAddress
): void {
  if (
    address.host !== '127.0.0.1' ||
    !Number.isInteger(address.port) ||
    address.port < 1 ||
    address.port > 65_535
  ) {
    throw new Error('browser_client_network_route_address_invalid')
  }
}

export function sameBrowserClientNetworkRouteAddress(
  left: BrowserClientNetworkRouteAddress,
  right: BrowserClientNetworkRouteAddress
): boolean {
  return left.host === right.host && left.port === right.port
}
