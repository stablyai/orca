// Why: keep device tokens and full URLs out of connection logs.
export function redactedWebSocketEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint)
    return (url.protocol === 'ws:' || url.protocol === 'wss:') && url.host ? url.host : 'unknown'
  } catch {
    return 'unknown'
  }
}
