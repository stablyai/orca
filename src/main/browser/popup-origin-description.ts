// Why: http on loopback is a secure context (local OAuth callback servers are
// common); only flag plain http to a real remote host.
function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]'
  )
}

// Why: the bar must show only the origin — popup URLs routinely carry OAuth
// codes and one-time tokens in path/query that must never reach UI surfaces.
export function describePopupOrigin(rawUrl: string): { label: string; insecure: boolean } {
  try {
    const parsed = new URL(rawUrl)
    if (parsed.origin !== 'null') {
      return {
        label: parsed.origin,
        insecure: parsed.protocol === 'http:' && !isLoopbackHost(parsed.hostname)
      }
    }
    if (parsed.protocol === 'about:') {
      return { label: 'about:blank', insecure: false }
    }
    return { label: parsed.protocol, insecure: false }
  } catch {
    return { label: 'unknown', insecure: true }
  }
}
