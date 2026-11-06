// Use the phone-connect route on either the assigned cell or director.
export function relayConnectWebSocketUrl(baseUrl: string, relayHostId: string): string {
  const url = new URL(baseUrl)
  url.protocol = 'wss:'
  url.pathname = `/v1/connect/${encodeURIComponent(relayHostId)}`
  return url.toString()
}
