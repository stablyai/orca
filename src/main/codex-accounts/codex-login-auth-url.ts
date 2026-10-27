import { stripAnsiEscapeSequences } from '../../shared/ansi-escape-sequences'

const AUTH_URL_MARKER = 'navigate to this url to authenticate:'
const CODEX_AUTH_HOST = 'auth.openai.com'

export function isCodexLoginAuthUrl(authUrl: string): boolean {
  try {
    return new URL(authUrl).hostname === CODEX_AUTH_HOST
  } catch {
    return false
  }
}

export function parseCodexLoginAuthUrl(output: string): string | null {
  const plain = stripAnsiEscapeSequences(output)
  const markerIndex = plain.toLowerCase().indexOf(AUTH_URL_MARKER)
  // Require the auth marker so update and documentation links cannot be offered for sign-in.
  if (markerIndex === -1) {
    return null
  }
  const searchable = plain.slice(markerIndex + AUTH_URL_MARKER.length)
  // Wait for trailing whitespace so a partial output chunk cannot publish a truncated URL.
  const match = /(https:\/\/\S+?)[.,;:)\]]*\s/.exec(searchable)
  if (!match) {
    return null
  }
  try {
    return new URL(match[1]).toString()
  } catch {
    return null
  }
}
