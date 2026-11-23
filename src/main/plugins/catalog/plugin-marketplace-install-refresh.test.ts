import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { PluginMarketplaceFetchResult } from './plugin-marketplace-fetch'
import { PluginMarketplaceStore } from './plugin-marketplace-store'
import { PluginMarketplaceService } from './plugin-marketplace-service'
import { PluginMarketplaceInstaller } from './plugin-marketplace-installer'
import { refreshInstalledPluginCatalog } from './plugin-marketplace-shared-refresh'
import { installCatalogReleaseWithApproval } from './plugin-update-approval'
import * as pluginGit from '../installation/plugin-git-repository'
import * as pluginAtomicWrite from '../installation/plugin-atomic-file-write'
import { installPluginFromMarketplace } from '../installation/plugin-install'
import {
  discoverPlugins,
  isInvalidDiscoveredPlugin,
  type ValidDiscoveredPlugin
} from '../discovery/plugin-discovery'

const roots: string[] = []
const KEY = 'samples.demo'
const SOURCE = { kind: 'git' as const, url: 'https://github.com/samples/catalog.git', ref: 'main' }
const ENTRY = {
  id: KEY,
  source: { kind: 'git' as const, url: 'https://github.com/samples/demo.git', ref: 'main' },
  categories: []
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it.each([
  'withdrawn',
  'changed',
  'withdrawn-after-staging',
  'changed-after-staging',
  'unchanged'
] as const)(
  'revalidates a cached update before installation when the pending refresh leaves its offer %s',
  async (offer) => {
    const root = await mkdtemp(join(tmpdir(), 'orca-install-refresh-'))
    roots.push(root)
    const pluginsDir = join(root, 'plugins')
    let version = '1.0.0'
    let commit = 'a'.repeat(40)
    vi.spyOn(pluginGit, 'checkoutPluginGitSource').mockImplementation(async ({ destination }) => {
      await writeFile(
        join(destination, 'orca-plugin.json'),
        JSON.stringify({
          manifestVersion: 1,
          id: 'demo',
          publisher: 'samples',
          name: 'Demo',
          version,
          engines: { orca: '>=1.0.0' },
          pluginApi: 1,
          capabilities: [],
          contributes: {
            commands: [{ id: 'demo.open', title: 'Open', action: 'sidebar.left.toggle' }],
            keybindings: [{ command: 'demo.open', key: 'CmdOrCtrl+Shift+9' }]
          }
        })
      )
      return commit
    })
    const store = new PluginMarketplaceStore(join(root, 'plugins-data'))
    const source = await store.addSource(SOURCE)
    const afterStaging = offer.endsWith('-after-staging')
    const cached: PluginMarketplaceFetchResult = {
      marketplaceCommit: 'c'.repeat(40),
      marketplace: {
        name: 'Samples',
        owner: 'samples',
        plugins: [
          {
            ...ENTRY,
            source: afterStaging
              ? { ...ENTRY.source, url: 'https://github.com/samples/moved.git' }
              : ENTRY.source
          }
        ]
      }
    }
    await store.writeSnapshot({ source, ...cached })
    const baseline = await installPluginFromMarketplace({
      pluginsDir,
      hostVersion: '1.4.0',
      expectedPluginKey: KEY,
      expectedResolvedCommit: commit,
      marketplace: { url: SOURCE.url, ref: SOURCE.ref, resolvedCommit: cached.marketplaceCommit },
      plugin: ENTRY.source
    })
    if (!baseline.ok) {
      throw new Error(baseline.error)
    }
    const consents: Record<string, string> = { [KEY]: baseline.consentFingerprint }
    const consentWrites: string[] = []
    let discovered: ValidDiscoveredPlugin[] = []
    const pluginService = {
      options: {
        isPluginSystemEnabled: () => true,
        getPluginConsents: () => consents,
        getDisabledPlugins: () => []
      },
      findValidPlugin: (key: string) =>
        discovered.find((plugin) => plugin.pluginKey === key) ?? null,
      refresh: async () => {
        discovered = (
          await discoverPlugins({ pluginsDir, devPluginPaths: [], hostVersion: '1.4.0' })
        ).filter((plugin): plugin is ValidDiscoveredPlugin => !isInvalidDiscoveredPlugin(plugin))
      }
    }
    await pluginService.refresh()
    const pending = Promise.withResolvers<PluginMarketplaceFetchResult>()
    let nextFetch = pending.promise
    const marketplace = new PluginMarketplaceService({
      pluginsDataDir: join(root, 'plugins-data'),
      store,
      fetcher: () => nextFetch
    })
    if (afterStaging) {
      const rename = pluginAtomicWrite.renamePluginFileWithWindowsRetry
      vi.spyOn(pluginAtomicWrite, 'renamePluginFileWithWindowsRetry').mockImplementation(
        async (from, to) => {
          await rename(from, to)
          if (from.endsWith('.staging')) {
            nextFetch = Promise.resolve({
              marketplaceCommit: 'd'.repeat(40),
              marketplace: {
                ...cached.marketplace,
                plugins: offer.startsWith('withdrawn')
                  ? []
                  : [{ ...ENTRY, source: { ...ENTRY.source, ref: 'next' } }]
              }
            })
            await marketplace.refreshSource(source.id)
          }
        }
      )
    }
    const installer = new PluginMarketplaceInstaller({
      marketplace,
      userDataPath: root,
      hostVersion: '1.4.0',
      revokeConsent: async (key) => {
        consentWrites.push('revoke')
        delete consents[key]
      }
    })
    await refreshInstalledPluginCatalog({ installer, marketplace }, KEY, 0)
    version = '1.1.0'
    commit = 'b'.repeat(40)
    const preview = await installer.previewInstalledUpdate(KEY)
    expect(preview.marketplaceCommit).toBe('c'.repeat(40))
    const installing = installCatalogReleaseWithApproval({
      pluginKey: KEY,
      pluginService,
      install: () => installer.install(preview),
      approve: async (key, fingerprint) => {
        consentWrites.push('approve')
        consents[key] = fingerprint
      }
    })
    // Let installation reach its first I/O boundary while the catalog fetch is still held.
    await new Promise<void>((resolve) => setImmediate(resolve))
    pending.resolve(
      offer === 'unchanged' || afterStaging
        ? cached
        : {
            marketplaceCommit: 'd'.repeat(40),
            marketplace: {
              ...cached.marketplace,
              plugins:
                offer === 'withdrawn'
                  ? []
                  : [{ ...ENTRY, source: { ...ENTRY.source, ref: 'next' } }]
            }
          }
    )
    const result = await installing
    const locked = (await installer.readInstallLockfile()).plugins[KEY]
    if (offer === 'unchanged') {
      expect(result).toMatchObject({ ok: true, version: '1.1.0', needsReview: false })
      expect(locked.version).toBe('1.1.0')
      expect(consents[KEY]).toBe(preview.consentFingerprint)
      expect(consentWrites).toEqual(['approve'])
    } else {
      expect(result).toEqual({
        ok: false,
        error: 'marketplace changed after preview; review the plugin again'
      })
      expect(locked.version).toBe('1.0.0')
      expect(consents[KEY]).toBe(baseline.consentFingerprint)
      expect(consentWrites).toEqual([])
    }
    await marketplace.refreshSourceShared(source.id)
  }
)

it('refuses confirmation after ten seconds of a held catalog refresh without installing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-install-refresh-timeout-'))
  roots.push(root)
  const store = new PluginMarketplaceStore(join(root, 'plugins-data'))
  const source = await store.addSource(SOURCE)
  const cached: PluginMarketplaceFetchResult = {
    marketplaceCommit: 'c'.repeat(40),
    marketplace: { name: 'Samples', owner: 'samples', plugins: [ENTRY] }
  }
  await store.writeSnapshot({ source, ...cached })
  const pending = Promise.withResolvers<PluginMarketplaceFetchResult>()
  const marketplace = new PluginMarketplaceService({
    pluginsDataDir: join(root, 'plugins-data'),
    store,
    fetcher: () => pending.promise
  })
  const installer = new PluginMarketplaceInstaller({
    marketplace,
    userDataPath: root,
    hostVersion: '1.4.0',
    revokeConsent: async () => {
      throw new Error('consent must not be written')
    }
  })
  const refreshing = marketplace.refreshSource(source.id)
  vi.useFakeTimers()
  let result: Awaited<ReturnType<PluginMarketplaceInstaller['install']>> | undefined
  const installing = installer
    .install({
      marketplaceSourceId: source.id,
      marketplaceCommit: 'c'.repeat(40),
      pluginKey: KEY,
      resolvedCommit: 'b'.repeat(40)
    })
    .then((next) => {
      result = next
    })
  try {
    await vi.advanceTimersByTimeAsync(10_000)
    expect(result).toEqual({
      ok: false,
      error: 'The plugin catalog is still updating. Try again in a moment.'
    })
    expect((await installer.readInstallLockfile()).plugins).toEqual({})
  } finally {
    vi.useRealTimers()
    pending.resolve({ ...cached, marketplace: { ...cached.marketplace, plugins: [] } })
    await refreshing
    await installing
  }
})
