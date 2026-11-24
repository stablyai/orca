import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { Store } from '../../persistence/loading-store/store'
import {
  closeTestStores,
  createSqliteTestStore,
  readPersistedStateJson
} from '../../persistence/persistence-test-harness'
import { PluginService } from '../plugin-service'
import { applyPluginConsent } from '../activation/plugin-enablement'
import { installStagedPluginTree } from '../installation/plugin-install-staging'
import { PluginMarketplaceStore } from './plugin-marketplace-store'
import { PluginMarketplaceService } from './plugin-marketplace-service'
import {
  withInstalledMarketplaceEligibility,
  withMarketplaceInstallEligibility
} from './plugin-marketplace-install-eligibility'

const roots: string[] = []
const services: PluginService[] = []
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()))
  await closeTestStores()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it.each(['withdrawn', 'unchanged'] as const)(
  'checks the installed offer before persisting consent when the catalog is %s',
  async (offer) => {
    const root = await mkdtemp(join(tmpdir(), 'orca-catalog-consent-'))
    roots.push(root)
    const catalog = {
      kind: 'git' as const,
      url: 'https://github.com/samples/catalog.git',
      ref: 'main'
    }
    const plugin = { kind: 'git' as const, url: 'https://github.com/samples/demo.git', ref: 'main' }
    const catalogStore = new PluginMarketplaceStore(join(root, 'plugins-data'))
    const source = await catalogStore.addSource(catalog)
    const snapshot = {
      marketplaceCommit: 'c'.repeat(40),
      marketplace: {
        name: 'Samples',
        owner: 'samples',
        plugins: [{ id: 'samples.demo', source: plugin, categories: [] }]
      }
    }
    await catalogStore.writeSnapshot({ source, ...snapshot })
    const marketplace = new PluginMarketplaceService({
      pluginsDataDir: join(root, 'plugins-data'),
      store: catalogStore,
      fetcher: async () =>
        offer === 'unchanged'
          ? snapshot
          : {
              marketplaceCommit: 'd'.repeat(40),
              marketplace: { ...snapshot.marketplace, plugins: [] }
            }
    })
    const stagingDir = join(root, 'source')
    await mkdir(stagingDir)
    await writeFile(
      join(stagingDir, 'orca-plugin.json'),
      JSON.stringify({
        manifestVersion: 1,
        id: 'demo',
        publisher: 'samples',
        name: 'Demo',
        version: '1.0.0',
        engines: { orca: '>=1.0.0' },
        pluginApi: 1,
        capabilities: [],
        contributes: {
          commands: [{ id: 'demo.open', title: 'Open', action: 'sidebar.left.toggle' }],
          keybindings: [{ command: 'demo.open', key: 'CmdOrCtrl+Shift+9' }]
        }
      })
    )
    const installed = await installStagedPluginTree({
      pluginsDir: join(root, 'plugins'),
      stagingDir,
      hostVersion: '1.4.0',
      source: {
        kind: 'marketplace',
        marketplace: {
          url: catalog.url,
          ref: catalog.ref,
          resolvedCommit: snapshot.marketplaceCommit
        },
        plugin
      },
      resolvedCommit: 'b'.repeat(40),
      identity: { pluginKey: 'samples.demo' }
    })
    if (!installed.ok) {
      throw new Error(installed.error)
    }
    const dataFile = join(root, 'settings.json')
    const store = createSqliteTestStore(Store, { dataFile })
    store.updateSettings({ pluginSystemEnabled: true, pluginConsents: {} })
    const pluginService = new PluginService({
      userDataPath: root,
      hostVersion: '1.4.0',
      isPluginSystemEnabled: () => true,
      getDisabledPlugins: () => store.getSettings().disabledPlugins ?? [],
      getPluginConsents: () => store.getSettings().pluginConsents ?? {},
      getDevPluginPaths: () => [],
      withMarketplaceApproval: (key, write) =>
        withInstalledMarketplaceEligibility(marketplace, root, key, write)
    })
    services.push(pluginService)
    await pluginService.refresh()
    await marketplace.refreshSource(source.id)
    const approval = applyPluginConsent({
      store,
      pluginService,
      pluginKey: 'samples.demo',
      reviewedFingerprint: installed.consentFingerprint,
      decision: 'approve'
    })
    await (offer === 'withdrawn'
      ? expect(approval).rejects.toThrow(
          'marketplace changed after preview; review the plugin again'
        )
      : approval)
    await store.flushOrThrow()
    const persisted = JSON.parse(readPersistedStateJson(dataFile))
    expect(persisted.settings.pluginConsents).toEqual(
      offer === 'withdrawn' ? {} : { 'samples.demo': installed.consentFingerprint }
    )
  }
)

it('keeps a catalog generation fixed until its guarded write finishes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-catalog-generation-'))
  roots.push(root)
  const store = new PluginMarketplaceStore(root)
  const source = await store.addSource({
    kind: 'git',
    url: 'https://github.com/samples/catalog.git',
    ref: 'main'
  })
  const snapshot = {
    source,
    marketplaceCommit: 'c'.repeat(40),
    marketplace: {
      name: 'Samples',
      owner: 'samples',
      plugins: [
        {
          id: 'samples.demo',
          source: { kind: 'git' as const, url: 'https://github.com/samples/demo.git', ref: 'main' },
          categories: []
        }
      ]
    }
  }
  await store.writeSnapshot(snapshot)
  const marketplace = new PluginMarketplaceService({ pluginsDataDir: root, store })
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const order: string[] = []
  const admitted = await marketplace.findPlugin(source.id, 'samples.demo')
  if (!admitted) {
    throw new Error('fixture offer missing')
  }
  const publishing = withMarketplaceInstallEligibility(marketplace, admitted, async () => {
    order.push('write started')
    entered.resolve()
    await release.promise
    expect((await marketplace.findPlugin(source.id, 'samples.demo'))?.marketplaceCommit).toBe(
      'c'.repeat(40)
    )
    order.push('write finished')
  })
  await entered.promise
  const changed = store
    .writeSnapshot({
      ...snapshot,
      marketplaceCommit: 'd'.repeat(40),
      marketplace: { ...snapshot.marketplace, plugins: [] }
    })
    .then(() => order.push('catalog changed'))
  release.resolve()
  await Promise.all([publishing, changed])
  expect(order).toEqual(['write started', 'write finished', 'catalog changed'])
  expect(await marketplace.findPlugin(source.id, 'samples.demo')).toBeNull()
})
