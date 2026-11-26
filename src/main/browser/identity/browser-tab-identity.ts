// Share identity between WebContents, CDP and request hooks so user agents and client hints agree.

import { release } from 'node:os'
import { app } from 'electron'
import { loadWindowsNativeRegistry } from '../../windows/windows-native-registry'
import type { BrowserProcessUserAgentIdentity } from './browser-process-user-agent'
import {
  chromeShapedSiteUserAgent,
  googleAuthUserAgent,
  isChromeShapedSiteUrl,
  isGoogleAuthUrl
} from './browser-site-user-agent'

type UserAgentBrand = { brand: string; version: string }

/** CDP requires these; it fills omitted brands, versions, bitness and form factors natively. */
export type CdpUserAgentMetadata = {
  platform: string
  platformVersion: string
  architecture: string
  model: string
  mobile: boolean
}

export type UserAgentMetadata = CdpUserAgentMetadata & {
  brands: UserAgentBrand[]
  fullVersionList: UserAgentBrand[]
  fullVersion: string
}

export type BrowserTabIdentity =
  /** Chromium's desktop client hints; temporary CDP overrides restate them. */
  | { kind: 'process'; userAgent: string }
  /** A host-pinned UA (Google sign-in, Chase) with the same desktop client hints. */
  | { kind: 'site'; userAgent: string }
  | { kind: 'mobile'; userAgent: string; userAgentMetadata: UserAgentMetadata }

type SiteTabIdentity = Extract<BrowserTabIdentity, { kind: 'site' }>

export function googleAuthTabIdentity(): SiteTabIdentity {
  return { kind: 'site', userAgent: googleAuthUserAgent() }
}

function chromeShapedSiteTabIdentity(): SiteTabIdentity {
  return { kind: 'site', userAgent: chromeShapedSiteUserAgent() }
}

const SITE_TAB_IDENTITY_RULES = [
  { identity: googleAuthTabIdentity, matchesUrl: isGoogleAuthUrl },
  { identity: chromeShapedSiteTabIdentity, matchesUrl: isChromeShapedSiteUrl }
]

/** Only a UA distinct from the process UA can mark a tab's request as belonging to its site. */
export function distinctSiteTabIdentities(
  processUserAgent: string
): { identity: SiteTabIdentity; matchesUrl: (url: string) => boolean }[] {
  return SITE_TAB_IDENTITY_RULES.map((rule) => ({
    identity: rule.identity(),
    matchesUrl: rule.matchesUrl
  })).filter((rule) => rule.identity.userAgent !== processUserAgent)
}

// Desktop presets preserve process identity; only mobile presets replace it.
export function resolveBrowserTabIdentity(args: {
  url: string
  mobile: boolean
  processIdentity: BrowserProcessUserAgentIdentity
}): BrowserTabIdentity {
  // Sign-in hosts outrank mobile presets: Google rejects identities claiming another browser.
  if (isGoogleAuthUrl(args.url)) {
    return googleAuthTabIdentity()
  }
  if (args.mobile) {
    return buildMobileTabIdentity(args.processIdentity.userAgent)
  }
  if (isChromeShapedSiteUrl(args.url)) {
    return chromeShapedSiteTabIdentity()
  }
  return { kind: 'process', userAgent: args.processIdentity.userAgent }
}

let desktopMetadata: CdpUserAgentMetadata | undefined

/** Chromium's own desktop values; a UA-only CDP override would blank every client hint. */
export function desktopUserAgentMetadata(): CdpUserAgentMetadata {
  desktopMetadata ??= {
    platform:
      process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux',
    platformVersion: desktopPlatformVersion(),
    architecture: desktopArchitecture(),
    model: '',
    mobile: false
  }
  return desktopMetadata
}

function desktopPlatformVersion(): string {
  if (process.platform === 'darwin') {
    // Chromium formats the same SysInfo numbers as major.minor.bugfix.
    return process.getSystemVersion?.() ?? ''
  }
  // Chromium withholds the Linux version.
  return process.platform === 'win32' ? windowsUniversalApiContractVersion() : ''
}

// Chromium reports this contract's HIWORD.LOWORD, falling back to its highest known version.
function windowsUniversalApiContractVersion(): string {
  const build = Number(release().split('.')[2])
  if (build < 17763) {
    // Before 1809 Chromium maps the Windows 10 release (build threshold) to its contract version.
    return `${[10586, 14393, 15063, 16299, 17134].filter((min) => build >= min).length + 1}.0.0`
  }
  try {
    const registry = loadWindowsNativeRegistry()
    const contract = registry.getRegistryKey(
      registry.HK.LM,
      'SOFTWARE\\Microsoft\\WindowsRuntime\\WellKnownContracts'
    )?.['Windows.Foundation.UniversalApiContract']?.value
    if (typeof contract === 'number') {
      return `${contract >>> 16}.${contract & 0xffff}.0`
    }
  } catch {
    // The registry addon ships with the desktop app only.
  }
  return '19.0.0'
}

// Chromium reports the hardware, so x64 builds translated on ARM present arm.
function desktopArchitecture(): string {
  if (process.arch === 'arm64' || process.arch === 'arm' || app.runningUnderARM64Translation) {
    return 'arm'
  }
  return process.arch === 'x64' || process.arch === 'ia32' ? 'x86' : ''
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
