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

    // Why: Windows OSC-7 cwd updates can describe both drive-letter paths
    // (`file:///C:/repo`) and UNC shares (`file://server/share/repo`). Use the
    // hostname when present so live cwd tracking, snapshots, and restore all
    // round-trip to a native Windows path instead of dropping the server name.
    if (url.hostname) {
      return `\\\\${url.hostname}${decodedPath.replace(/\//g, '\\')}`
    }
    if (/^\/[A-Za-z]:/.test(decodedPath)) {
      return decodedPath.slice(1)
    }
    return decodedPath.replace(/\//g, '\\')
  } catch {
    return null
  }
}
