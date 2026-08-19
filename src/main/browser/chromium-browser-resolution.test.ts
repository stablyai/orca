import { describe, expect, it } from 'vitest'
import type { DiscoveredBrowserCandidate } from './installed-browser-discovery'
import {
  resolveBrowserCandidate,
  resolveWithUserOverride,
  type KnownBrowserEntry
} from './chromium-browser-resolution'

const APP_SUPPORT = '/Users/test/Library/Application Support'

function candidate(
  displayName: string,
  bundleId = `id.${displayName}`
): DiscoveredBrowserCandidate {
  return { bundleId, displayName, appPath: `/Applications/${displayName}.app` }
}

function slash(p: string): string {
  return p.replace(/\\/g, '/')
}

describe('resolveBrowserCandidate', () => {
  it('known fast path: a candidate matching a hardcoded entry keeps that entry (zero-config)', () => {
    const known: KnownBrowserEntry = {
      family: 'chrome',
      label: 'Google Chrome',
      dataDir: `${APP_SUPPORT}/Google Chrome`,
      keychainService: 'Chrome Safe Storage',
      keychainAccount: 'Chrome'
    }
    const res = resolveBrowserCandidate(candidate('Google Chrome'), {
      knownBrowsers: [known],
      appSupportRoot: APP_SUPPORT,
      existsSync: () => true
    })
    expect(res.status).toBe('resolved')
    if (res.status !== 'resolved') {
      return
    }
    // Keeps the maintained family + verified keychain, NOT a guessed 'custom'.
    expect(res.browser.family).toBe('chrome')
    expect(res.browser.keychainService).toBe('Chrome Safe Storage')
    expect(res.browser.customBrowserId).toBeUndefined()
  })

  it('convention: unknown candidate with an existing data dir resolves to custom via "<Name> Safe Storage" (legacy Cookies)', () => {
    const existsSync = (p: string): boolean => {
      const n = slash(String(p))
      if (n.endsWith('Application Support/Aside/Local State')) {
        return true
      }
      if (n.endsWith('Application Support/Aside/Default/Network/Cookies')) {
        return false
      }
      if (n.endsWith('Application Support/Aside/Default/Cookies')) {
        return true
      }
      return false
    }
    const res = resolveBrowserCandidate(candidate('Aside', 'at.studio.AsideBrowser'), {
      knownBrowsers: [],
      appSupportRoot: APP_SUPPORT,
      existsSync: existsSync as never
    })
    expect(res.status).toBe('resolved')
    if (res.status !== 'resolved') {
      return
    }
    expect(res.browser.family).toBe('custom')
    expect(res.browser.customBrowserId).toBe('at.studio.AsideBrowser')
    expect(res.browser.label).toBe('Aside')
    expect(res.browser.keychainService).toBe('Aside Safe Storage')
    expect(res.browser.keychainAccount).toBe('Aside')
    expect(slash(res.browser.dataDir)).toBe('/Users/test/Library/Application Support/Aside')
  })

  it('needs-setup: convention data dir missing → needs-setup, no guess', () => {
    const res = resolveBrowserCandidate(candidate('Ghost'), {
      knownBrowsers: [],
      appSupportRoot: APP_SUPPORT,
      existsSync: () => false
    })
    expect(res.status).toBe('needs-setup')
    if (res.status !== 'needs-setup') {
      return
    }
    expect(res.label).toBe('Ghost')
    expect(res.customBrowserId).toBe('id.Ghost')
    expect(res.appPath).toBe('/Applications/Ghost.app')
  })
})

describe('resolveWithUserOverride', () => {
  it('produces a custom resolution from an explicit folder + keychain', () => {
    const res = resolveWithUserOverride(candidate('Helium', 'net.imput.helium'), {
      dataDir: '/custom/Helium',
      keychainService: 'Helium Storage Key'
    })
    expect(res.status).toBe('resolved')
    if (res.status !== 'resolved') {
      return
    }
    expect(res.browser.family).toBe('custom')
    expect(res.browser.dataDir).toBe('/custom/Helium')
    expect(res.browser.keychainService).toBe('Helium Storage Key')
    // keychainAccount defaults to the display name when the user leaves it blank.
    expect(res.browser.keychainAccount).toBe('Helium')
    expect(res.browser.customBrowserId).toBe('net.imput.helium')
  })
})
