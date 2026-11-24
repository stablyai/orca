import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import { Store } from '../../persistence/loading-store/store'
import { closeTestStores, createSqliteTestStore } from '../../persistence/persistence-test-harness'
import { PluginService } from '../plugin-service'
import { installStagedPluginTree } from '../installation/plugin-install-staging'
import { PluginMarketplaceStore } from './plugin-marketplace-store'
import { PluginMarketplaceService } from './plugin-marketplace-service'
import { withInstalledMarketplaceEligibility } from './plugin-marketplace-install-eligibility'
import type { PluginMarketplaceFetchResult } from './plugin-marketplace-fetch'

vi.mock('../runtime/plugin-service-host-call', () => {
  const unexpectedHostCall = (): never => {
    throw new Error('catalog review fixtures do not execute host calls')
  }
  return {
    createPluginServiceHostCall: () => unexpectedHostCall,
    resolvePluginServiceHostCallPolicy: unexpectedHostCall,
    pluginPanelBridgeServices: unexpectedHostCall
  }
})

export const REVIEW_KEY = 'samples.demo'
export const REVIEW_CATALOG = {
  kind: 'git' as const,
  url: 'https://github.com/samples/catalog.git',
  ref: 'main'
}
export const REVIEW_ENTRY = {
  id: REVIEW_KEY,
  source: { kind: 'git' as const, url: 'https://github.com/samples/demo.git', ref: 'main' },
  categories: []
}
const fixtures: { root: string; service: PluginService }[] = []

export async function disposeMarketplaceReviewFixtures(): Promise<void> {
  const current = fixtures.splice(0)
  await Promise.all(current.map(({ service }) => service.dispose()))
  await closeTestStores()
  await Promise.all(current.map(({ root }) => rm(root, { recursive: true, force: true })))
}

export async function createMarketplaceReviewFixture() {
  const root = await mkdtemp(join(tmpdir(), 'orca-marketplace-review-'))
  const pluginsDir = join(root, 'plugins')
  const catalogStore = new PluginMarketplaceStore(join(root, 'plugins-data'))
  const source = await catalogStore.addSource(REVIEW_CATALOG)
  let snapshot: PluginMarketplaceFetchResult = {
    marketplaceCommit: 'c'.repeat(40),
    marketplace: { name: 'Samples', owner: 'samples', plugins: [REVIEW_ENTRY] }
  }
  await catalogStore.writeSnapshot({ source, ...snapshot })
  const marketplace = new PluginMarketplaceService({
    pluginsDataDir: join(root, 'plugins-data'),
    store: catalogStore,
    fetcher: async () => snapshot
  })
  const store = createSqliteTestStore(Store, { dataFile: join(root, 'settings.json') })
  store.updateSettings({ pluginSystemEnabled: true, pluginConsents: {}, disabledPlugins: [] })
  const service = new PluginService({
    userDataPath: root,
    hostVersion: '1.4.0',
    isPluginSystemEnabled: () => true,
    getDisabledPlugins: () => store.getSettings().disabledPlugins ?? [],
    getPluginConsents: () => store.getSettings().pluginConsents ?? {},
    getDevPluginPaths: () => [],
    withMarketplaceApproval: (key, write) =>
      withInstalledMarketplaceEligibility(marketplace, root, key, write)
  })
  fixtures.push({ root, service })
  const tree = async (version: string, id = 'demo', capabilities: unknown[] = []) => {
    const directory = await mkdtemp(join(root, 'tree-'))
    await mkdir(directory, { recursive: true })
    await writeFile(
      join(directory, 'orca-plugin.json'),
      JSON.stringify({
        manifestVersion: 1,
        id,
        publisher: 'samples',
        name: id,
        version,
        engines: { orca: '>=1.0.0' },
        pluginApi: 1,
        capabilities,
        contributes: {
          commands: [{ id: `${id}.open`, title: 'Open', action: 'sidebar.left.toggle' }],
          keybindings: [{ command: `${id}.open`, key: 'CmdOrCtrl+Shift+9' }]
        }
      })
    )
    return directory
  }
  const install = async (
    stagingDir: string,
    pluginKey = REVIEW_KEY,
    plugin = REVIEW_ENTRY.source,
    resolvedCommit = 'a'.repeat(40)
  ) => {
    const result = await installStagedPluginTree({
      pluginsDir,
      stagingDir,
      hostVersion: '1.4.0',
      source: {
        kind: 'marketplace',
        marketplace: {
          url: REVIEW_CATALOG.url,
          ref: REVIEW_CATALOG.ref,
          resolvedCommit: snapshot.marketplaceCommit
        },
        plugin
      },
      resolvedCommit,
      identity: { pluginKey }
    })
    if (!result.ok) {
      throw new Error(result.error)
    }
    return result
  }
  const refresh = async (plugins = snapshot.marketplace.plugins, commit = 'd'.repeat(40)) => {
    snapshot = { marketplaceCommit: commit, marketplace: { ...snapshot.marketplace, plugins } }
    await marketplace.refreshSource(source.id)
  }
  return {
    root,
    pluginsDir,
    store,
    service,
    source,
    marketplace,
    catalogStore,
    tree,
    install,
    refresh
  }
}
