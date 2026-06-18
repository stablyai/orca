export function parseFileUriPath(uri: string): string | null {
  try {
    const url = new URL(uri)
    if (url.protocol !== 'file:') {
      return null
    }

    const decodedPath = decodeURIComponent(url.pathname)
    if (process.platform !== 'win32') {
      return decodedPath
    }

    if (/^\/[A-Za-z]:/.test(decodedPath)) {
      return decodedPath.slice(1)
    }
    // Why: localhost/empty-host OSC-7 URIs are POSIX paths even when parsed by
    // a Windows app; only non-local hosts describe Windows UNC shares.
    if (url.hostname && url.hostname !== 'localhost') {
      return `\\\\${url.hostname}${decodedPath.replace(/\//g, '\\')}`
    }
    return decodedPath
  } catch {
    return null
  }
}
