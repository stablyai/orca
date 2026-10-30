import { toWindowsWslPath } from '../../shared/wsl-paths'
import { escapeLiteralPercent, hasNulCharacter } from '../../shared/osc7-path-text'

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

const FILE_URI_AUTHORITY = /^file:\/\/[^/]*/i

// oxlint-disable-next-line no-control-regex -- a URL parser strips or trims raw C0 bytes, so they are encoded.
const RAW_C0_OR_SPACE = /[\u0000-\u0020]/g

/**
 * Some shells (nushell) send `#`, `?`, a lone `%`, spaces and control bytes raw in the path. A URL
 * parser would cut the path at `#`/`?`, reject the `%`, and strip or trim the rest, naming another
 * folder. A properly encoded URI from a sender that never sends a query or fragment has none of
 * them there, so its result is unchanged. A raw `%41` stays ambiguous and decodes to `A`.
 */
function encodeRawPathDelimiters(uri: string): string {
  const authority = FILE_URI_AUTHORITY.exec(uri)
  if (!authority) {
    return uri
  }
  const path = escapeLiteralPercent(uri.slice(authority[0].length))
    .replace(/#/g, '%23')
    .replace(/\?/g, '%3F')
    .replace(
      RAW_C0_OR_SPACE,
      (char) => `%${char.charCodeAt(0).toString(16).padStart(2, '0').toUpperCase()}`
    )
  return authority[0] + path
}

export function parseFileUriPathParts(
  uri: string,
  options: ParseFileUriPathOptions = {}
): ParsedFileUriPath | null {
  try {
    const url = new URL(encodeRawPathDelimiters(uri))
    if (url.protocol !== 'file:') {
      return null
    }

    const decodedPath = decodeURIComponent(url.pathname)
    if (hasNulCharacter(decodedPath)) {
      return null
    }
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
    // Local and remote-POSIX authorities keep POSIX paths; other nonlocal Windows authorities become UNC.
    if (hostname && hostname !== 'localhost' && !options.remotePosixAuthority) {
      return { path: `\\\\${url.hostname}${decodedPath.replace(/\//g, '\\')}`, hostname }
    }
    return { path: decodedPath, hostname }
  } catch {
    return null
  }
}
