import {
  cleanElectronUserAgent,
  getBrowserProcessUserAgentIdentity,
  stripElectronToken
} from './browser-process-user-agent'
import {
  isChromeShapedSiteHost,
  isTeamsHost
} from '../../../shared/browser/identity/browser-site-hosts'

// Restrict the Electron identity to sign-in hosts; post-auth apps retain the profile identity.
const GOOGLE_AUTH_HOSTS = new Set(['accounts.google.com', 'accounts.youtube.com'])

function hostnameOf(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).hostname.toLowerCase()
  } catch {
    return null
  }
}

export function isGoogleAuthUrl(rawUrl: string): boolean {
  const hostname = hostnameOf(rawUrl)
  return hostname !== null && GOOGLE_AUTH_HOSTS.has(hostname)
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

export function isChromeShapedSiteUrl(rawUrl: string): boolean {
  const hostname = hostnameOf(rawUrl)
  return hostname !== null && isChromeShapedSiteHost(hostname)
}

// Equals the process UA in Cleaned mode, so the rule only changes anything under Native.
export function chromeShapedSiteUserAgent(): string {
  return cleanElectronUserAgent(getBrowserProcessUserAgentIdentity().electronUserAgent)
}

/** Teams decides on the request header alone, so only the header drops the Electron token. */
export function teamsRequestUserAgent(rawUrl: string, userAgent: string): string {
  // Cleaned already omits the token; a Google sign-in UA there must keep it.
  if (getBrowserProcessUserAgentIdentity().mode !== 'native') {
    return userAgent
  }
  const hostname = hostnameOf(rawUrl)
  return hostname !== null && isTeamsHost(hostname) ? stripElectronToken(userAgent) : userAgent
}
