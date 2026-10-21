// Why one owner: a tab's identity is read by the session request hook and written to the guest over
// two layers (the WebContents UA and a CDP override that outranks it). When each layer derived it on
// its own, a desktop viewport preset installed a CDP override with no userAgentMetadata, and Chromium
// then drops navigator.userAgentData and every sec-ch-ua header for that tab — a Chrome UA with no
// client hints, which bot checks read as a spoof. Every layer now asks this module instead.

import type { BrowserProcessUserAgentIdentity } from './browser-process-user-agent'
import { googleAuthUserAgent, isGoogleAuthUrl } from './browser-google-auth-ua'

type UserAgentBrand = { brand: string; version: string }

export type UserAgentMetadata = {
  brands: UserAgentBrand[]
  fullVersionList: UserAgentBrand[]
  fullVersion: string
  platform: string
  platformVersion: string
  architecture: string
  model: string
  mobile: boolean
}

export type BrowserTabIdentity =
  /** The process identity, with its client hints left to Chromium. */
  | { kind: 'process'; userAgent: string }
  /** Firefox on Google's auth hosts; real Firefox sends no client hints. */
  | { kind: 'google-auth'; userAgent: string }
  | { kind: 'mobile'; userAgent: string; userAgentMetadata: UserAgentMetadata }

export function googleAuthTabIdentity(): BrowserTabIdentity {
  return { kind: 'google-auth', userAgent: googleAuthUserAgent() }
}

/**
 * The identity a tab presents at `url`. Desktop presets and "no preset" are deliberately the same
 * input: only a mobile preset changes who the tab claims to be.
 */
export function resolveBrowserTabIdentity(args: {
  url: string
  mobile: boolean
  processIdentity: BrowserProcessUserAgentIdentity
}): BrowserTabIdentity {
  // Firefox is delivered per-target and cannot reach workers; keep it clean-only to preserve one
  // coherent identity per mode instead of pairing a Firefox document with native workers.
  if (args.processIdentity.mode === 'clean' && isGoogleAuthUrl(args.url)) {
    return googleAuthTabIdentity()
  }
  if (args.mobile) {
    return buildMobileTabIdentity(args.processIdentity.userAgent)
  }
  return { kind: 'process', userAgent: args.processIdentity.userAgent }
}

// Why: responsive sites UA-sniff; this is Chrome DevTools' default iPhone UA template with the real
// Chrome major spliced in so the userAgentMetadata brands below agree with it.
function buildMobileUserAgent(chromeMajor: string): string {
  return `Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/${chromeMajor}.0.0.0 Mobile/15E148 Safari/604.1`
}

function extractChromeMajor(ua: string): string {
  const match = ua.match(/Chrome\/(\d+)/)
  return match ? match[1] : '134'
}

function buildMobileTabIdentity(processUserAgent: string): BrowserTabIdentity {
  const chromeMajor = extractChromeMajor(processUserAgent)
  // Why: userAgentMetadata must accompany the mobile UA so client hints match, or bot-detection flags the desktop-hint leak.
  return {
    kind: 'mobile',
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
