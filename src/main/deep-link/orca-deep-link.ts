// Why: `orca://` is an OS-registered scheme (electron-builder `protocols`), so any web
// page or app can hand Orca one of these URLs. Every route here is limited to revealing
// a local pane — parsing is side-effect free and never carries material that could run
// a command or mutate state. `orca://pair` stays a paste-only string on purpose: auto-
// applying pairing auth from an untrusted link would be unsafe.

export const ORCA_URL_SCHEME = 'orca'

export type OrcaFocusDeepLink = {
  kind: 'focus'
  /** Runtime-issued terminal handle (`term_<uuid>`) to reveal, when the link names one. */
  terminal: string | null
  /**
   * Worktree selector (`id:`, `path:`, `branch:`, `name:`, `issue:`, or a bare value)
   * whose active terminal is revealed when no handle is given.
   */
  worktree: string | null
}

export type OrcaDeepLink = OrcaFocusDeepLink

// Why: handles ride into the runtime's lookup tables verbatim, so anything outside the
// runtime's own alphabet is rejected here instead of reaching the focus action.
const TERMINAL_HANDLE_PATTERN = /^[A-Za-z0-9_-]{1,128}$/
// Why bounded: a selector is matched against worktree ids/paths/branches; a runaway
// argv or a hostile page must not be able to push kilobytes into that comparison.
const MAX_WORKTREE_SELECTOR_LENGTH = 1024

/**
 * Parse an `orca://` URL into a structured route, or `null` when it is malformed, uses
 * another scheme, targets a host with no OS route, or carries an invalid target.
 *
 * Two spellings reveal a terminal by handle — `orca://focus/<handle>` and
 * `orca://focus?terminal=<handle>` — and `orca://focus?worktree=<selector>` reveals a
 * worktree's active terminal. A bare `orca://focus` only brings the app forward.
 */
export function parseOrcaDeepLink(url: string): OrcaDeepLink | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== `${ORCA_URL_SCHEME}:`) {
    return null
  }
  // Why hostname, not path: the route is a fixed lowercase word, while the handle it
  // carries is case-sensitive and so rides in the path or query untouched.
  switch (parsed.hostname) {
    case 'focus':
      return parseFocusDeepLink(parsed)
    default:
      return null
  }
}

function parseFocusDeepLink(parsed: URL): OrcaFocusDeepLink | null {
  const pathHandle = decodePathSegment(parsed.pathname)
  if (pathHandle === undefined) {
    return null
  }
  const terminal = pathHandle ?? normalizeParam(parsed.searchParams.get('terminal'))
  if (terminal !== null && !TERMINAL_HANDLE_PATTERN.test(terminal)) {
    return null
  }
  const worktree = normalizeParam(parsed.searchParams.get('worktree'))
  if (worktree !== null && worktree.length > MAX_WORKTREE_SELECTOR_LENGTH) {
    return null
  }
  return { kind: 'focus', terminal, worktree }
}

/**
 * The single path segment of `orca://focus/<handle>`: `null` when the path is empty,
 * `undefined` when it is not a lone decodable segment (so the caller rejects the link).
 */
function decodePathSegment(pathname: string): string | null | undefined {
  const segment = pathname.replace(/^\/+/, '')
  if (segment.length === 0) {
    return null
  }
  if (segment.includes('/')) {
    return undefined
  }
  try {
    return decodeURIComponent(segment)
  } catch {
    return undefined
  }
}

function normalizeParam(value: string | null): string | null {
  const trimmed = value?.trim() ?? ''
  return trimmed.length > 0 ? trimmed : null
}

/**
 * The focus link carried by a launch or second-instance argv, if any. Windows and Linux
 * deliver protocol launches as a plain argv entry; macOS uses `open-url` instead. Only a
 * link that parses counts, so skill-share and other `orca://` entries never match here.
 */
export function focusDeepLinkFromArguments(argv: readonly string[]): OrcaFocusDeepLink | null {
  for (const value of argv) {
    if (typeof value !== 'string' || !value.toLowerCase().startsWith(`${ORCA_URL_SCHEME}:`)) {
      continue
    }
    const link = parseOrcaDeepLink(value)
    if (link) {
      return link
    }
  }
  return null
}
