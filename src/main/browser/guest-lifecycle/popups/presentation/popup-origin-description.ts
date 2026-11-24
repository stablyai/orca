// Loopback HTTP is a secure context, commonly used by local OAuth callbacks.
function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]'
  )
}

// Exclude paths and queries: popup URLs can carry OAuth codes and one-time tokens.
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
