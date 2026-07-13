// Why: Orca registers `orca://` as an OS custom protocol, so any web page or
// app can trigger these links. Every route here is intentionally limited to
// focusing/revealing a local pane — parsing must be side-effect free and must
// never carry material that could execute commands or mutate state.

export const ORCA_URL_SCHEME = 'orca'

export type OrcaFocusDeepLink = {
  kind: 'focus'
  // Explicit terminal handle (`term_<uuid>`) to reveal, when provided.
  terminal: string | null
  // Worktree selector (`id:`, `path:`, `branch:`, `name:`, `issue:`, or a bare
  // id/path/branch) whose active terminal is revealed when no handle is given.
  worktree: string | null
}

export type OrcaDeepLink = OrcaFocusDeepLink

/**
 * Parse an `orca://` deep link into a structured route, or `null` when the URL
 * is malformed, uses another scheme, or targets a host with no OS route.
 *
 * Modeled on `extractPairingCodeFromUrl` in `src/shared/pairing.ts`: validate
 * the scheme, then dispatch on the hostname. Unknown hosts (including the
 * paste-only `pair` code format) return `null` rather than throwing so the
 * intake can still bring Orca to the foreground.
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
  switch (parsed.hostname) {
    case 'focus':
      return parseFocusDeepLink(parsed)
    default:
      return null
  }
}

/**
 * Build the `focus` route from a validated `orca://focus` URL, reading the
 * optional `terminal` and `worktree` query params (both normalized to `null`
 * when absent or blank).
 */
function parseFocusDeepLink(parsed: URL): OrcaFocusDeepLink {
  return {
    kind: 'focus',
    terminal: normalizeParam(parsed.searchParams.get('terminal')),
    worktree: normalizeParam(parsed.searchParams.get('worktree'))
  }
}

/** Trim a raw query-param value, collapsing missing or whitespace-only input to `null`. */
function normalizeParam(value: string | null): string | null {
  if (value === null) {
    return null
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * Find the first `orca://` URL in a process argv array. Windows and Linux
 * deliver protocol launches as a plain argv entry (cold start via
 * `process.argv`, warm launch via the `second-instance` argv) rather than a
 * dedicated event, unlike macOS which emits `open-url`.
 *
 * Returns any `orca://` URL — even a route this build does not handle — so the
 * intake still surfaces the app; the dispatcher decides what to do with it.
 */
export function findOrcaUrlInArgv(argv: readonly string[]): string | null {
  for (const arg of argv) {
    if (typeof arg === 'string' && arg.toLowerCase().startsWith(`${ORCA_URL_SCHEME}://`)) {
      return arg
    }
  }
  return null
}
