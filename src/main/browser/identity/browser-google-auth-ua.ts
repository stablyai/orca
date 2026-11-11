import { getBrowserProcessUserAgentIdentity } from './browser-process-user-agent'

// Restrict the Electron identity to sign-in hosts; post-auth apps retain the profile identity.
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

// Google rejects sign-in from any identity claiming another browser, so present Electron's own.
export function googleAuthUserAgent(): string {
  return getBrowserProcessUserAgentIdentity().electronUserAgent
}
