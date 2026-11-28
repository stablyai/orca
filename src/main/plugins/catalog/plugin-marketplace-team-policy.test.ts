import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { OrcaCloudCapabilities } from '../../../shared/orca-profiles/orca-cloud-capabilities'
import {
  OFFICIAL_MARKETPLACE_GIT_SOURCE,
  pluginMarketplaceListingSchema
} from '../../../shared/plugins/catalog/plugin-marketplace'
import { COMMUNITY_MARKETPLACE_GIT_SOURCE } from '../../../shared/plugins/catalog/plugin-install-link'
import { PluginMarketplaceService } from './plugin-marketplace-service'
import { PluginMarketplaceStore } from './plugin-marketplace-store'

it('protects managed catalogs from both governing teams and blocks excluded sources', async () => {
  const pluginsDataDir = await mkdtemp(join(tmpdir(), 'orca-plugin-policy-'))
  const store = new PluginMarketplaceStore(pluginsDataDir)
  const community = COMMUNITY_MARKETPLACE_GIT_SOURCE
  const member = { ...community, url: 'https://git.example.com/member/catalog.git' }
  const internal = {
    kind: 'git',
    url: 'https://git.example.com/my-team/catalog.git',
    ref: 'main'
  } as const
  const secondInternal = { ...internal, url: 'https://git.example.com/another-team/catalog.git' }
  let capabilities: OrcaCloudCapabilities | undefined = {
    flags: {
      team_settings: true,
      'plugins.official': false,
      'plugins.community': false,
      'plugins.memberSources': false
    },
    refreshedAt: 1,
    teamPolicy: { orgIds: ['org_a', 'org_b'], internalCatalogs: [internal, secondInternal] }
  }
  const marketplace = new PluginMarketplaceService({
    pluginsDataDir,
    store,
    getTeamCapabilities: () => capabilities
  })
  try {
    await store.addSource(OFFICIAL_MARKETPLACE_GIT_SOURCE)
    await store.addSource(community)
    await store.addSource(member)
    const sources = await marketplace.listSources()
    expect(sources.map(({ source, managed }) => [source.url, managed])).toEqual([
      [internal.url, true],
      [secondInternal.url, true]
    ])
    await expect(marketplace.addSource(community)).rejects.toThrow('turned off by your team')
    await expect(marketplace.removeSource(sources[1]!.id)).rejects.toThrow('managed by your team')
    await expect(marketplace.addSource(member)).rejects.toThrow('turned off by your team')
    expect(marketplace.allowsSource({ ...community, ref: 'member-branch' })).toBe(false)

    capabilities.flags['plugins.community'] = true
    expect((await marketplace.listSources()).map(({ source }) => source.url)).toEqual([
      community.url,
      internal.url,
      secondInternal.url
    ])
    capabilities.flags['plugins.community'] = false
    capabilities.flags['plugins.memberSources'] = true
    expect((await marketplace.listSources()).map(({ source }) => source.url)).toEqual([
      member.url,
      internal.url,
      secondInternal.url
    ])

    capabilities = undefined
    expect((await marketplace.listSources()).map(({ source }) => source.url)).toEqual([
      'https://github.com/stablyai/orca-plugins.git',
      community.url,
      member.url
    ])
  } finally {
    await rm(pluginsDataDir, { recursive: true, force: true })
  }
})

it('keeps discovery and install lookups within every governing version range and catalog', async () => {
  const pluginsDataDir = await mkdtemp(join(tmpdir(), 'orca-plugin-range-'))
  const store = new PluginMarketplaceStore(pluginsDataDir)
  const internal = {
    kind: 'git',
    url: 'https://git.example.com/acme/catalog.git',
    ref: 'main'
  } as const
  const other = { ...internal, url: 'https://git.example.com/other/catalog.git' }
  const pluginKey = 'acme.theme'
  const policy: NonNullable<OrcaCloudCapabilities['teamPolicy']> = {
    orgIds: ['org_a', 'org_b'],
    internalCatalogs: [internal, other],
    requiredPlugins: [pluginKey],
    requiredPluginRules: [
      { pluginKey, catalog: internal, version: '^1.0.0' },
      { pluginKey, catalog: internal, version: '>=1.3.0 <1.6.0' }
    ]
  }
  const marketplace = new PluginMarketplaceService({
    pluginsDataDir,
    store,
    hostVersion: '2.0.0',
    getTeamCapabilities: () => ({
      refreshedAt: 1,
      flags: { team_settings: true },
      teamPolicy: policy
    })
  })
  try {
    const catalog = pluginMarketplaceListingSchema.parse({
      name: 'Themes',
      owner: 'acme',
      plugins: [
        {
          id: pluginKey,
          categories: [],
          source: { ...internal, url: 'https://git.example.com/acme/theme.git' },
          releases: ['2.0.0', '1.8.0', '1.5.0', '1.4.0', '1.0.0'].map((version, index) => ({
            version,
            commit: String(index + 1).repeat(40),
            contentHash: String(index + 1).repeat(64),
            execution: 'data',
            minimumOrca: version === '1.5.0' ? '3.0.0' : '1.0.0'
          }))
        }
      ]
    })
    const internalSource = await store.addSource(internal)
    const otherSource = await store.addSource(other)
    for (const source of [internalSource, otherSource]) {
      await store.writeSnapshot({ source, marketplace: catalog, marketplaceCommit: 'a'.repeat(40) })
    }

    const listings = await marketplace.listCachedPlugins()
    expect(
      listings.map(({ marketplaceSourceId, release }) => [marketplaceSourceId, release?.version])
    ).toEqual([[internalSource.id, '1.4.0']])
    expect(await marketplace.findPlugin(internalSource.id, pluginKey)).toMatchObject({
      release: { version: '1.4.0' },
      releases: [{ version: '1.5.0' }, { version: '1.4.0' }]
    })
    expect(await marketplace.findPlugin(otherSource.id, pluginKey)).toBeNull()
    policy.requiredPluginRules?.push({ pluginKey, catalog: internal, version: '^2.0.0' })
    expect(await marketplace.findPlugin(internalSource.id, pluginKey)).toBeNull()
  } finally {
    await rm(pluginsDataDir, { recursive: true, force: true })
  }
})
