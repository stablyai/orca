// Restrict the Firefox identity to sign-in hosts; post-auth apps retain the profile identity.
const GOOGLE_AUTH_HOSTS = new Set(['accounts.google.com', 'accounts.youtube.com'])

export function isGoogleAuthUrl(rawUrl: string): boolean {
  try {
    return GOOGLE_AUTH_HOSTS.has(new URL(rawUrl).hostname.toLowerCase())
  } catch {
    return false
  }
}

export function shouldUseGoogleAuthIdentity(
  url: string,
  referrer: string,
  resourceType: string
): boolean {
  if (isGoogleAuthUrl(url)) {
    return true
  }
  // Auth-referrer subresources may leave before the WebContents UA override is applied.
  return resourceType !== 'mainFrame' && isGoogleAuthUrl(referrer)
}

// Keep Firefox version tokens consistent and select the host OS token.
export function googleAuthUserAgent(): string {
  const platform =
    process.platform === 'darwin'
      ? 'Macintosh; Intel Mac OS X 10.15'
      : process.platform === 'win32'
        ? 'Windows NT 10.0; Win64; x64'
        : 'X11; Linux x86_64'
  return `Mozilla/5.0 (${platform}; rv:140.0) Gecko/20100101 Firefox/140.0`
}

// Firefox does not send Chromium's sec-ch-ua* headers.
export function stripClientHints(headers: Record<string, string>): void {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase().startsWith('sec-ch-ua')) {
      delete headers[key]
    }
  }
}

// Replace case-insensitively to avoid duplicate User-Agent headers.
export function setUserAgentHeader(headers: Record<string, string>, value: string): void {
  const existing = Object.keys(headers).find((key) => key.toLowerCase() === 'user-agent')
  headers[existing ?? 'User-Agent'] = value
}

// The outgoing UA identifies auth-document requests even across hosts.
export function currentUserAgent(headers: Record<string, string>): string | undefined {
  const existing = Object.keys(headers).find((key) => key.toLowerCase() === 'user-agent')
  return existing ? headers[existing] : undefined
}
