import type { TerminalInputSource } from '../../runtime/terminal-input-source'

/** What the host answers for a pane key: not a pane it owns, or its last input (null before any). */
export type TerminalInputSourceResolution =
  | { pane: 'unknown' }
  | { pane: 'known'; source: TerminalInputSource | null }

export type TerminalInputSourceResolver = (paneKey: string) => TerminalInputSourceResolution

const ROUTE_PREFIX = '/pane/'
const ROUTE_SUFFIX = '/last-input'

/**
 * Returns the pane key from `/pane/<paneKey>/last-input`, or null for any other path.
 * The segment is always percent-decoded; pane keys never contain `%`, so a raw key decodes to itself.
 */
export function parseTerminalInputSourcePath(pathname: string): string | null {
  if (!pathname.startsWith(ROUTE_PREFIX) || !pathname.endsWith(ROUTE_SUFFIX)) {
    return null
  }
  const encoded = pathname.slice(ROUTE_PREFIX.length, pathname.length - ROUTE_SUFFIX.length)
  if (!encoded || encoded.includes('/')) {
    return null
  }
  try {
    return decodeURIComponent(encoded)
  } catch {
    return null
  }
}
