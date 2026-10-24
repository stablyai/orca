import { describe, expect, it } from 'vitest'
import { fingerprintPluginConsent } from '../../../shared/plugins/approval/plugin-consent-fingerprint'
import { pluginManifestSchema } from '../../../shared/plugins/manifest/plugin-manifest'
import type { ValidDiscoveredPlugin } from '../plugin-discovery'
import { findPluginFileTypeSuggestion } from './plugin-file-type-suggestion'
import type { PluginMarketplaceListing } from './plugin-marketplace-projection'

function listing(
  pluginKey: string,
  fileTypes: string[],
  extra: Partial<PluginMarketplaceListing> = {}
) {
  return {
    marketplaceSourceId: 'official',
    marketplaceName: 'Orca',
    marketplaceOwner: 'stablyai',
    marketplaceCommit: 'c'.repeat(40),
    pluginKey,
    source: { kind: 'git', url: `https://example.invalid/${pluginKey}.git`, ref: 'v1' },
    categories: [],
    official: true,
    bundled: false,
    release: {
      version: '1.0.0',
      commit: 'c'.repeat(40),
      contentHash: 'f'.repeat(64),
      execution: 'data',
      minimumOrca: '1.4.0',
      types: ['syntax'],
      fileTypes
    },
    ...extra
  } satisfies PluginMarketplaceListing
}

function installed(pluginKey: string, extensions: string[]): ValidDiscoveredPlugin {
  const [publisher = '', id = ''] = pluginKey.split('.')
  const manifest = pluginManifestSchema.parse({
    manifestVersion: 1,
    id,
    publisher,
    name: id,
    version: '1.0.0',
    engines: { orca: '>=1.0.0' },
    pluginApi: 1,
    contributes: {
      syntaxes: extensions.length
        ? [{ id: 'lang', label: 'Lang', scopeName: 'source.lang', path: 'g.json', extensions }]
        : []
    }
  })
  return {
    pluginKey,
    rootDir: '/tmp/none',
    manifest,
    consentFingerprint: fingerprintPluginConsent(manifest),
    contentHash: null,
    isDev: false
  }
}

const on = { pluginSystemEnabled: true }
const listings = [
  listing('community.typst', ['typ'], { official: false, marketplaceSourceId: 'community' }),
  listing('samples.blocked', ['typ'], { blockedByKillList: { reason: 'revoked' } }),
  listing('samples.first', ['typ'], {
    release: { ...listing('x', []).release, fileTypes: ['typ'], name: 'Typst' }
  }),
  listing('samples.second', ['typ', 'gleam'])
]

describe('findPluginFileTypeSuggestion', () => {
  it('picks the first official, unblocked catalog plugin and carries its release name', () => {
    expect(
      findPluginFileTypeSuggestion({ fileType: 'typ', settings: on, listings, installed: [] })
    ).toEqual({
      marketplaceSourceId: 'official',
      pluginKey: 'samples.first',
      fileType: 'typ',
      name: 'Typst'
    })
  })

  it('suggests nothing when off, dismissed, or the plugin system is off', () => {
    for (const settings of [
      { pluginSystemEnabled: false },
      { ...on, pluginFileTypeSuggestions: false },
      { ...on, pluginDismissedFileTypes: ['typ'] }
    ]) {
      expect(
        findPluginFileTypeSuggestion({ fileType: 'typ', settings, listings, installed: [] })
      ).toBeNull()
    }
  })

  it('suggests nothing an installed plugin already handles, and skips installed listings', () => {
    expect(
      findPluginFileTypeSuggestion({
        fileType: 'typ',
        settings: on,
        listings,
        installed: [installed('local.typst', ['.TYP'])]
      })
    ).toBeNull()
    expect(
      findPluginFileTypeSuggestion({
        fileType: 'typ',
        settings: on,
        listings,
        installed: [installed('samples.first', [])]
      })?.pluginKey
    ).toBe('samples.second')
  })
})
