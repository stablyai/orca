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
    // and UNC shares. Convert those native forms only; SSH/WSL-style POSIX
    // paths must stay slash paths even when Orca itself runs on Windows.
    if (url.hostname && url.hostname !== 'localhost') {
      return `\\\\${url.hostname}${decodedPath.replace(/\//g, '\\')}`
    }
    if (/^\/[A-Za-z]:/.test(decodedPath)) {
      return decodedPath.slice(1)
    }
    return decodedPath
  } catch {
    return null
  }
}
