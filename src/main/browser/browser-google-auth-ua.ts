// Why: Google binds a signed-in session to the browser identity that created it.
// Cookies copied in from another browser (or sent under an Electron/Chrome-shaped
// UA that doesn't match a real first-party browser) get flagged by anti-fraud on
// accounts.google.com and expire within ~1h. Presenting a Firefox identity scoped
// to Google's auth hosts lets the user sign in *inside* the embedded browser, so
// Google issues cookies bound to THIS browser that self-refresh — instead of us
// transplanting cookies that go stale. Scope is deliberately the auth hosts only:
// post-auth app surfaces (mail.google.com, myaccount.google.com, drive, etc.) keep
// the profile's real Chrome-shaped identity so nothing else about the session shifts.

// Why: exact hostname match — subdomains such as myaccount.google.com are post-auth
// app surfaces, not the sign-in flow, and must retain the profile's real identity.
const GOOGLE_AUTH_HOSTS = new Set(['accounts.google.com', 'accounts.youtube.com'])

export function isGoogleAuthUrl(rawUrl: string): boolean {
  try {
    return GOOGLE_AUTH_HOSTS.has(new URL(rawUrl).hostname.toLowerCase())
  } catch {
    return false
  }
}

// Why: rv:/Gecko/Firefox tokens must line up with a real released build and the
// platform token must match the host OS, or the UA is internally inconsistent and
// itself a bot tell.
export function googleAuthUserAgent(): string {
  const platform =
    process.platform === 'darwin'
      ? 'Macintosh; Intel Mac OS X 10.15'
      : process.platform === 'win32'
        ? 'Windows NT 10.0; Win64; x64'
        : 'X11; Linux x86_64'
  return `Mozilla/5.0 (${platform}; rv:140.0) Gecko/20100101 Firefox/140.0`
}

// Why: real Firefox emits no sec-ch-ua* client hints; leaving Chromium's hints on a
// Firefox UA is a sharper mismatch than either signal alone.
export function stripClientHints(headers: Record<string, string>): void {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase().startsWith('sec-ch-ua')) {
      delete headers[key]
    }
  }
}

// Why: the user-agent request header may already carry a base identity under a
// different case; overwrite the existing key rather than adding a duplicate.
export function setUserAgentHeader(headers: Record<string, string>, value: string): void {
  const existing = Object.keys(headers).find((key) => key.toLowerCase() === 'user-agent')
  headers[existing ?? 'User-Agent'] = value
}
