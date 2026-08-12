import { toWindowsWslPath } from '../../shared/wsl-paths'

export type ParsedFileUriPath = {
  path: string
  hostname: string
}

export type ParseFileUriPathOptions = {
  pathFlavor?: 'posix' | 'win32'
  remotePosixAuthority?: boolean
  wslDistro?: string
}

export function parseFileUriPath(
  uri: string,
  options: ParseFileUriPathOptions = {}
): string | null {
  return parseFileUriPathParts(uri, options)?.path ?? null
}

export function parseFileUriPathParts(
  uri: string,
  options: ParseFileUriPathOptions = {}
): ParsedFileUriPath | null {
  try {
    const url = new URL(uri)
    if (url.protocol !== 'file:') {
      return null
    }

    const decodedPath = decodeURIComponent(url.pathname)
    const hostname = url.hostname.toLowerCase()
    if (options.wslDistro) {
      return { path: toWindowsWslPath(decodedPath, options.wslDistro), hostname }
    }
    const pathFlavor = options.pathFlavor ?? (process.platform === 'win32' ? 'win32' : 'posix')
    if (pathFlavor !== 'win32') {
      return { path: decodedPath, hostname }
    }

    if (/^\/[A-Za-z]:/.test(decodedPath)) {
      return { path: decodedPath.slice(1), hostname }
    }
    // Why: localhost/empty-host OSC-7 URIs are POSIX paths even when parsed by
    // a Windows app; only non-local hosts describe Windows UNC shares.
    if (hostname && hostname !== 'localhost' && !options.remotePosixAuthority) {
      return { path: `\\\\${url.hostname}${decodedPath.replace(/\//g, '\\')}`, hostname }
    }
    return { path: decodedPath, hostname }
  } catch {
    return null
  }
}
