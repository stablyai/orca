// Share identity between WebContents, CDP and request hooks so user agents and client hints agree.

import { release } from 'node:os'
import { app } from 'electron'
import { loadWindowsNativeRegistry } from '../../windows/windows-native-registry'
import type { BrowserProcessUserAgentIdentity } from './browser-process-user-agent'
import { googleAuthUserAgent, isGoogleAuthUrl } from './browser-google-auth-ua'

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
  /** Electron's own UA on Google sign-in hosts, with the same desktop client hints. */
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
  // Sign-in hosts outrank mobile presets: Google rejects identities claiming another browser.
  if (isGoogleAuthUrl(args.url)) {
    return googleAuthTabIdentity()
  }
  if (args.mobile) {
    return buildMobileTabIdentity(args.processIdentity.userAgent)
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
