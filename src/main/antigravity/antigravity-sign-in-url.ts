// `agy acp --login` prints Google's sign-in link on its own line, then reads the code (or the
// address of the page Google lands on) from stdin. Only Google's own link back to agy's callback
// page is shown or opened, and only one line is ever written back.

const MAX_CHARS = 16_384
const AGY_LOGIN_REDIRECT = 'https://antigravity.google/oauth-callback'
const AUTH_PATHS = new Set(['/o/oauth2/auth', '/o/oauth2/v2/auth'])

/** The sign-in link on one line of agy's output, or null for any other line. */
export function agyLoginLink(line: string): string | null {
  const link = line.trim()
  if (link.length > MAX_CHARS || /\s/.test(link) || !URL.canParse(link)) {
    return null
  }
  const url = new URL(link)
  const one = (name: string): string =>
    url.searchParams.getAll(name).length === 1 ? (url.searchParams.get(name) ?? '') : ''
  const valid =
    url.origin === 'https://accounts.google.com' &&
    AUTH_PATHS.has(url.pathname) &&
    !url.username &&
    !url.password &&
    !url.hash &&
    one('response_type') === 'code' &&
    one('redirect_uri') === AGY_LOGIN_REDIRECT &&
    /^\S{1,512}$/.test(one('state'))
  return valid ? link : null
}

/** What may be written to agy as the one line it reads: a code, or the callback page's address. */
export function agyLoginAnswer(pasted: string): string | null {
  const answer = pasted.trim()
  // One line only: agy reads up to the first newline.
  if (
    !answer ||
    answer.length > MAX_CHARS ||
    [...answer].some((char) => char < ' ' || char === '\x7f')
  ) {
    return null
  }
  if (!URL.canParse(answer)) {
    // A bare code has no spaces.
    return /\s/.test(answer) ? null : answer
  }
  const url = new URL(answer)
  return `${url.origin}${url.pathname}` === AGY_LOGIN_REDIRECT && url.searchParams.get('code')
    ? answer
    : null
}
