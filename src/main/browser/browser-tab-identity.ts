// Share identity between WebContents, CDP and request hooks so user agents and client hints agree.

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
  /** Desktop client hints remain browser-owned. */
  | { kind: 'process'; userAgent: string }
  /** Firefox auth identity omits client hints. */
  | { kind: 'google-auth'; userAgent: string }
  | { kind: 'mobile'; userAgent: string; userAgentMetadata: UserAgentMetadata }

export function googleAuthTabIdentity(): BrowserTabIdentity {
  return { kind: 'google-auth', userAgent: googleAuthUserAgent() }
}

// Desktop presets preserve process identity; only mobile presets replace it.
export function resolveBrowserTabIdentity(args: {
  url: string
  mobile: boolean
  processIdentity: BrowserProcessUserAgentIdentity
}): BrowserTabIdentity {
  // Native mode must preserve its process identity on auth requests.
  if (args.processIdentity.mode === 'clean' && isGoogleAuthUrl(args.url)) {
    return googleAuthTabIdentity()
  }
  if (args.mobile) {
    return buildMobileTabIdentity(args.processIdentity.userAgent)
  }
  return { kind: 'process', userAgent: args.processIdentity.userAgent }
}

// Match the mobile UA version to the client-hint brands.
function buildMobileUserAgent(chromeMajor: string): string {
  return `Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/${chromeMajor}.0.0.0 Mobile/15E148 Safari/604.1`
}

function extractChromeMajor(ua: string): string {
  const match = ua.match(/Chrome\/(\d+)/)
  return match ? match[1] : '134'
}

function buildMobileTabIdentity(processUserAgent: string): BrowserTabIdentity {
  const chromeMajor = extractChromeMajor(processUserAgent)
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
