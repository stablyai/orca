// Why: a CDP Emulation.setUserAgentOverride outranks WebContents.setUserAgent for both
// navigator.userAgent and the outgoing request header, and it stands across every later
// navigation until explicitly cleared. So the viewport preset's UA is a third identity layer
// that must agree with the auth-host Firefox switch, or applying a preset silently reintroduces
// the exact UA mismatch this scope exists to remove.

import { googleAuthUserAgent, isGoogleAuthUrl } from './browser-google-auth-ua'

type UserAgentBrand = { brand: string; version: string }

export type ViewportUserAgentOverride = {
  userAgent: string
  userAgentMetadata?: {
    brands: UserAgentBrand[]
    fullVersionList: UserAgentBrand[]
    fullVersion: string
    platform: string
    platformVersion: string
    architecture: string
    model: string
    mobile: boolean
  }
}

// Why: responsive sites UA-sniff; this is Chrome DevTools' default iPhone UA template with the real
// Chrome major spliced in to keep sec-ch-ua consistent (see setupClientHintsOverride).
function buildMobileUserAgent(chromeMajor: string): string {
  return `Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/${chromeMajor}.0.0.0 Mobile/15E148 Safari/604.1`
}

function extractChromeMajor(ua: string): string {
  const match = ua.match(/Chrome\/(\d+)/)
  return match ? match[1] : '134'
}

export function buildViewportUserAgentOverride(args: {
  url: string
  mobile: boolean
  baseUserAgent: string
}): ViewportUserAgentOverride {
  if (isGoogleAuthUrl(args.url)) {
    // Why: match the header-level Firefox switch exactly, and send no userAgentMetadata — real
    // Firefox emits no client hints, so Chrome brands here would contradict the stripped headers.
    return { userAgent: googleAuthUserAgent() }
  }
  if (!args.mobile) {
    // Why: desktop presets still need the clean (non-Electron) UA so Cloudflare/Turnstile don't flag the session.
    return { userAgent: args.baseUserAgent }
  }
  const chromeMajor = extractChromeMajor(args.baseUserAgent)
  // Why: userAgentMetadata must accompany the mobile UA so client hints match, or bot-detection flags the desktop-hint leak.
  return {
    userAgent: buildMobileUserAgent(chromeMajor),
    userAgentMetadata: {
      brands: [
        { brand: 'Google Chrome', version: chromeMajor },
        { brand: 'Chromium', version: chromeMajor },
        { brand: 'Not/A)Brand', version: '24' }
      ],
      fullVersionList: [
        { brand: 'Google Chrome', version: `${chromeMajor}.0.0.0` },
        { brand: 'Chromium', version: `${chromeMajor}.0.0.0` },
        { brand: 'Not/A)Brand', version: '24.0.0.0' }
      ],
      fullVersion: `${chromeMajor}.0.0.0`,
      platform: 'iOS',
      platformVersion: '17.0',
      architecture: '',
      model: 'iPhone',
      mobile: true
    }
  }
}
