/** Truncate WS URLs for connection logs (no tokens / full paths). */
export function redactedEndpoint(ep: string): string {
  try {
    const m = ep.match(/^wss?:\/\/([^/]+)/i)
    return m ? m[1]! : 'unknown'
  } catch {
    return 'unknown'
  }
}
