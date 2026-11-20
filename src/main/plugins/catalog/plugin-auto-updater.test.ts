import { describe, expect, it, vi } from 'vitest'
import type { PluginLockfile } from '../../../shared/plugins/installation/plugin-install-lockfile'
import { PluginAutoUpdater } from './plugin-auto-updater'

function makeUpdater(readInstallLockfile: () => Promise<PluginLockfile>) {
  const refreshCatalogs = vi.fn(async () => undefined)
  const updater = new PluginAutoUpdater({
    pluginService: {
      options: {} as never,
      getDiscovered: () => [],
      findValidPlugin: () => null,
      refresh: async () => undefined
    },
    installer: {
      readInstallLockfile,
      findInstalledUpdateListing: vi.fn(),
      previewInstalledUpdate: vi.fn(),
      install: vi.fn()
    } as never,
    firstSeen: { firstSeen: vi.fn() } as never,
    isEnabled: () => true,
    refreshCatalogs,
    refreshKillList: vi.fn(async () => undefined),
    approve: vi.fn(async () => undefined),
    onChanged: vi.fn()
  })
  return { updater, refreshCatalogs }
}

const marketplaceEntry = {
  pluginKey: 'acme.theme',
  source: {
    kind: 'marketplace',
    marketplace: {
      url: 'https://github.com/stablyai/orca-community-plugins.git',
      ref: 'main',
      resolvedCommit: 'a'.repeat(40)
    },
    plugin: { url: 'https://github.com/stablyai/orca-community-plugins.git', ref: 'main' }
  }
}

describe('PluginAutoUpdater catalog refresh', () => {
  it('does not clone catalogs when no plugin was installed from one', async () => {
    const { updater, refreshCatalogs } = makeUpdater(
      async () =>
        ({
          version: 1,
          plugins: {
            'acme.local': { pluginKey: 'acme.local', source: { kind: 'local-path', path: '/x' } }
          }
        }) as never
    )
    await updater.run()
    expect(refreshCatalogs).not.toHaveBeenCalled()
  })

  it('refreshes catalogs when a marketplace install exists', async () => {
    const { updater, refreshCatalogs } = makeUpdater(
      async () =>
        ({
          version: 1,
          plugins: { 'acme.theme': marketplaceEntry }
        }) as never
    )
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
