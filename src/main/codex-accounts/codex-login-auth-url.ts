import { stripAnsiEscapeSequences } from '../../shared/ansi-escape-sequences'

const AUTH_URL_MARKER = 'navigate to this url to authenticate:'
const CODEX_AUTH_HOST = 'auth.openai.com'

/** OpenAI's sign-in page, the only link Orca opens for a codex login. */
export function isCodexLoginAuthUrl(authUrl: string): boolean {
  try {
    return new URL(authUrl).hostname === CODEX_AUTH_HOST
  } catch {
    return false
  }
}

/**
 * The browser sign-in link `codex login` prints, or null while its output has
 * not carried a complete one yet.
 */
export function parseCodexLoginAuthUrl(output: string): string | null {
  const plain = stripAnsiEscapeSequences(output)
  const markerIndex = plain.toLowerCase().indexOf(AUTH_URL_MARKER)
  // Why the marker is required: without it the first https link codex happens to
  // print — an update notice, a docs link — would be offered as the sign-in link.
  // If codex rewords the line, no link beats the wrong one.
  if (markerIndex === -1) {
    return null
  }
  const searchable = plain.slice(markerIndex + AUTH_URL_MARKER.length)
  // Why: the trailing whitespace is required, not incidental. Output arrives in
  // chunks, and a flush that ends mid-token would otherwise publish a truncated
  // link that authenticates nothing.
  const match = /(https:\/\/\S+?)[.,;:)\]]*\s/.exec(searchable)
  if (!match) {
    return null
  }
  try {
    // Only the shape is trusted here; the pattern already fixed the scheme.
    return new URL(match[1]).toString()
  } catch {
    return null
  }
}
