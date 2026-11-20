import { describe, expect, it, vi } from 'vitest'
import type {
  PluginLockEntry,
  PluginLockfile
} from '../../../shared/plugins/installation/plugin-install-lockfile'
import { PluginAutoUpdater } from './plugin-auto-updater'

const CATALOG_URL = 'https://github.com/stablyai/orca-community-plugins.git'

function lockEntry(pluginKey: string, source: PluginLockEntry['source']): PluginLockEntry {
  return {
    pluginKey,
    version: '1.0.0',
    source,
    resolvedCommit: null,
    contentHash: 'a'.repeat(64),
    consentFingerprint: 'fingerprint',
    installedAt: 0
  }
}

function makeUpdater(readInstallLockfile: () => Promise<PluginLockfile>) {
  const refreshCatalogs = vi.fn(async () => undefined)
  const updater = new PluginAutoUpdater({
    pluginService: {
      options: {
        isPluginSystemEnabled: () => true,
        getPluginConsents: () => ({}),
        getDisabledPlugins: () => [],
        getPluginKillListEntry: () => null
      },
      getDiscovered: () => [],
      findValidPlugin: () => null,
      refresh: async () => undefined
    },
    installer: {
      readInstallLockfile,
      findInstalledUpdateListing: async () => null,
      previewInstalledUpdate: async () => {
        throw new Error('unexpected preview')
      },
      install: async () => {
        throw new Error('unexpected install')
      }
    },
    firstSeen: { firstSeen: async () => 0 },
    isEnabled: () => true,
    refreshCatalogs,
    refreshKillList: async () => undefined,
    approve: async () => undefined,
    onChanged: () => undefined
  })
  return { updater, refreshCatalogs }
}

describe('PluginAutoUpdater catalog refresh', () => {
  it('does not clone catalogs when no plugin was installed from one', async () => {
    const { updater, refreshCatalogs } = makeUpdater(async () => ({
      version: 1,
      plugins: { 'acme.local': lockEntry('acme.local', { kind: 'local-path', path: '/x' }) }
    }))
    await updater.run()
    expect(refreshCatalogs).not.toHaveBeenCalled()
  })

  it('refreshes catalogs when a marketplace install exists', async () => {
    const { updater, refreshCatalogs } = makeUpdater(async () => ({
      version: 1,
      plugins: {
        'acme.theme': lockEntry('acme.theme', {
          kind: 'marketplace',
          marketplace: { url: CATALOG_URL, ref: 'main', resolvedCommit: 'b'.repeat(40) },
          plugin: { url: CATALOG_URL, ref: 'main' }
        })
      }
    }))
    await updater.run()
    expect(refreshCatalogs).toHaveBeenCalledTimes(1)
  })

  it('refreshes catalogs when the lockfile cannot be read', async () => {
    const { updater, refreshCatalogs } = makeUpdater(async () => {
      throw new Error('EACCES')
    })
    await updater.run()
    expect(refreshCatalogs).toHaveBeenCalledTimes(1)
  })
})
