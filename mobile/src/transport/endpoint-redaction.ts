// Why: don't dump device tokens / full URLs into log scrolls; truncate to
// the host:port so reconnect lifecycles are still readable.
export function redactedEndpoint(ep: string): string {
  try {
    const m = ep.match(/^wss?:\/\/([^/]+)/i)
    return m ? m[1] : 'unknown'
  } catch {
    return 'unknown'
  }
}
