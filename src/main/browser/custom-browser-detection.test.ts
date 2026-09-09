import { describe, expect, it } from 'vitest'
import { customBrowsersFromCandidates } from './custom-browser-detection'
import type { KnownBrowserEntry } from './chromium-browser-resolution'
import type {
  ChromiumProfilesWithCookies,
  DiscoveredBrowserCandidate
} from './installed-browser-discovery'

const APP_SUPPORT = '/Users/test/Library/Application Support'

function candidate(
  displayName: string,
  bundleId = `id.${displayName}`
): DiscoveredBrowserCandidate {
  return { bundleId, displayName, appPath: `/Applications/${displayName}.app` }
}

// Default-profile resolver for candidates that own a Default cookie store.
function defaultProfilesFor(dataDir: string): ChromiumProfilesWithCookies {
  return {
    profiles: [{ name: 'Default', directory: 'Default' }],
    selectedProfile: 'Default',
    cookiesPath: `${dataDir}/Default/Cookies`
  }
}

describe('customBrowsersFromCandidates', () => {
  it('turns a convention-resolvable candidate into a custom DetectedBrowser', () => {
    const existsSync = (p: string): boolean =>
      p.replace(/\\/g, '/').endsWith('Application Support/Aside/Local State')
    const out = customBrowsersFromCandidates([candidate('Aside', 'at.studio.AsideBrowser')], {
      knownBrowsers: [],
      appSupportRoot: APP_SUPPORT,
      existsSync,
      profilesFor: defaultProfilesFor
    })
    expect(out).toHaveLength(1)
    expect(out[0].family).toBe('custom')
    expect(out[0].label).toBe('Aside')
    expect(out[0].keychainService).toBe('Aside Safe Storage')
    expect(out[0].keychainAccount).toBe('Aside')
    expect(out[0].customBrowserId).toBe('at.studio.AsideBrowser')
    expect(out[0].selectedProfile).toBe('Default')
    expect(out[0].cookiesPath.replace(/\\/g, '/')).toBe(
      '/Users/test/Library/Application Support/Aside/Default/Cookies'
    )
  })

  it('honors a non-Default selected profile from the resolver', () => {
    const existsSync = (p: string): boolean =>
      p.replace(/\\/g, '/').endsWith('Application Support/Ghosty/Local State')
    const out = customBrowsersFromCandidates([candidate('Ghosty')], {
      knownBrowsers: [],
      appSupportRoot: APP_SUPPORT,
      existsSync,
      profilesFor: (dataDir) => ({
        profiles: [
          { name: 'Default', directory: 'Default' },
          { name: 'Work', directory: 'Profile 1' }
        ],
        selectedProfile: 'Profile 1',
        cookiesPath: `${dataDir}/Profile 1/Network/Cookies`
      })
    })
    expect(out).toHaveLength(1)
    expect(out[0].selectedProfile).toBe('Profile 1')
    expect(out[0].profiles.map((p) => p.directory)).toEqual(['Default', 'Profile 1'])
    expect(out[0].cookiesPath.replace(/\\/g, '/')).toContain('Ghosty/Profile 1/Network/Cookies')
  })

  it('drops a candidate matching a hardcoded known entry (dedup)', () => {
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
      profilesFor: defaultProfilesFor
    })
    expect(out).toHaveLength(0)
  })

  it('drops a needs-setup candidate whose data dir is absent', () => {
    const out = customBrowsersFromCandidates([candidate('Ghost')], {
      knownBrowsers: [],
      appSupportRoot: APP_SUPPORT,
      existsSync: () => false,
      profilesFor: defaultProfilesFor
    })
    expect(out).toHaveLength(0)
  })

  it('drops a resolved candidate whose data dir owns no profile with cookies', () => {
    const out = customBrowsersFromCandidates([candidate('Empty')], {
      knownBrowsers: [],
      appSupportRoot: APP_SUPPORT,
      existsSync: () => true,
      profilesFor: () => null
    })
    expect(out).toHaveLength(0)
  })
})
