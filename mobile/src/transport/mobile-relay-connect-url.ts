/** The relay's phone connect socket for `relayHostId`, on a cell or on the director. */
export function relayConnectWebSocketUrl(baseUrl: string, relayHostId: string): string {
  const url = new URL(baseUrl)
  url.protocol = 'wss:'
  url.pathname = `/v1/connect/${encodeURIComponent(relayHostId)}`
  return url.toString()
}

export function relayWebSocketUrl(relay: { cellUrl: string; relayHostId: string }): string {
  return relayConnectWebSocketUrl(relay.cellUrl, relay.relayHostId)
}
