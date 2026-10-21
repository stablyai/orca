import { ANTIGRAVITY_BROWSER_MARKER } from './antigravity-browser-helper'
import type { AntigravitySignInPending } from './antigravity-sign-in-callback'

/** The line the server prints before its sign-in link. */
export const ANTIGRAVITY_SIGN_IN_PROMPT = 'Open the following link to authenticate the ACP server: '

const MAX_URL_CHARS = 16_384
const MAX_LINE_CHARS = ANTIGRAVITY_SIGN_IN_PROMPT.length + MAX_URL_CHARS + 2

/** The link only when it is Google's sign-in page sending the browser back to a loopback port on
 *  this host: it is opened for the person, so anything else is withheld. */
export function antigravitySignInUrl(
  link: string
): ({ url: string } & AntigravitySignInPending) | null {
  if (link.length > MAX_URL_CHARS || /\s/.test(link) || !URL.canParse(link)) {
    return null
  }
  const url = new URL(link)
  const one = (name: string): string =>
    url.searchParams.getAll(name).length === 1 ? (url.searchParams.get(name) ?? '') : ''
  const redirect = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/$/.exec(one('redirect_uri'))
  const port = Number(redirect?.[1])
  const valid =
    url.origin === 'https://accounts.google.com' &&
    url.pathname === '/o/oauth2/v2/auth' &&
    !url.username &&
    !url.password &&
    !url.hash &&
    one('response_type') === 'code' &&
    /^\S{1,512}$/.test(one('state')) &&
    port >= 1024 &&
    port <= 65_535
  return valid ? { url: link, redirectUri: one('redirect_uri'), state: one('state') } : null
}

/** A sign-in line's valid link; null for a malformed or overlong one, which is never an answer;
 *  undefined for any other line. Only error output carries the helper's line. */
export function readAntigravitySignInLine(
  line: string,
  source: 'stdout' | 'stderr'
): string | null | undefined {
  const text = line.endsWith('\r') ? line.slice(0, -1) : line
  let link: string
  if (text.startsWith(ANTIGRAVITY_SIGN_IN_PROMPT)) {
    link = text.slice(ANTIGRAVITY_SIGN_IN_PROMPT.length)
  } else if (source === 'stderr' && text.startsWith(ANTIGRAVITY_BROWSER_MARKER)) {
    try {
      const parsed: unknown = JSON.parse(text.slice(ANTIGRAVITY_BROWSER_MARKER.length))
      link = typeof parsed === 'string' ? parsed : ''
    } catch {
      link = ''
    }
  } else {
    return undefined
  }
  return text.length <= MAX_LINE_CHARS && antigravitySignInUrl(link) ? link : null
}
