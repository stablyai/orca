import { describe, expect, it } from 'vitest'
import { customBrowsersFromCandidates } from './custom-browser-detection'
import type { KnownBrowserEntry } from './chromium-browser-resolution'
import type { DiscoveredBrowserCandidate } from './installed-browser-discovery'

const APP_SUPPORT = '/Users/test/Library/Application Support'

function candidate(
  displayName: string,
  bundleId = `id.${displayName}`
): DiscoveredBrowserCandidate {
  return { bundleId, displayName, appPath: `/Applications/${displayName}.app` }
}

function cookiesPathFor(dataDir: string): string {
  return `${dataDir}/Default/Cookies`
}

describe('customBrowsersFromCandidates', () => {
  it('turns a convention-resolvable candidate into a custom DetectedBrowser', () => {
    const existsSync = (p: string): boolean => {
      const n = p.replace(/\\/g, '/')
      return n.endsWith('/Aside/Local State') || n.endsWith('/Aside/Default/Cookies')
    }
    const out = customBrowsersFromCandidates([candidate('Aside', 'at.studio.AsideBrowser')], {
      knownBrowsers: [],
      appSupportRoot: APP_SUPPORT,
      existsSync,
      cookiesPathFor
    })
    expect(out).toHaveLength(1)
    expect(out[0].family).toBe('custom')
    expect(out[0].label).toBe('Aside')
    expect(out[0].keychainService).toBe('Aside Safe Storage')
    expect(out[0].keychainAccount).toBe('Aside')
    expect(out[0].customBrowserId).toBe('at.studio.AsideBrowser')
    expect(out[0].cookiesPath.replace(/\\/g, '/')).toBe(
      '/Users/test/Library/Application Support/Aside/Default/Cookies'
    )
  })

  it('drops a candidate matching a hardcoded known entry (dedup — already in the hardcoded list)', () => {
    const known: KnownBrowserEntry = {
      family: 'edge',
      label: 'Microsoft Edge',
      dataDir: `${APP_SUPPORT}/Microsoft Edge`,
      keychainService: 'Microsoft Edge Safe Storage',
      keychainAccount: 'Microsoft Edge'
    }
    const out = customBrowsersFromCandidates([candidate('Microsoft Edge')], {
      knownBrowsers: [known],
      appSupportRoot: APP_SUPPORT,
      existsSync: () => true,
      cookiesPathFor
    })
    expect(out).toHaveLength(0)
  })

  it('drops a needs-setup candidate whose data dir is absent', () => {
    const out = customBrowsersFromCandidates([candidate('Ghost')], {
      knownBrowsers: [],
      appSupportRoot: APP_SUPPORT,
      existsSync: () => false,
      cookiesPathFor
    })
    expect(out).toHaveLength(0)
  })
})
