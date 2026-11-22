import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { OrcaCloudCapabilities } from '../../../shared/orca-profiles/orca-cloud-capabilities'
import { OFFICIAL_MARKETPLACE_GIT_SOURCE } from '../../../shared/plugins/catalog/plugin-marketplace'
import { PluginMarketplaceService } from './plugin-marketplace-service'
import { PluginMarketplaceStore } from './plugin-marketplace-store'

it('scopes the internal catalog to the active team and blocks excluded sources', async () => {
  const pluginsDataDir = await mkdtemp(join(tmpdir(), 'orca-plugin-policy-'))
  const store = new PluginMarketplaceStore(pluginsDataDir)
  const community = {
    kind: 'git',
    url: 'https://git.example.com/community/catalog.git',
    ref: 'main'
  } as const
  const internal = {
    kind: 'git',
    url: 'https://git.example.com/my-team/catalog.git',
    ref: 'main'
  } as const
  let capabilities: OrcaCloudCapabilities | undefined = {
    flags: { team_settings: true, 'plugins.official': false, 'plugins.community': false },
    refreshedAt: 1,
    teamPolicy: { orgId: 'org_a', internalCatalog: internal }
  }
  const marketplace = new PluginMarketplaceService({
    pluginsDataDir,
    store,
    getTeamCapabilities: () => capabilities
  })
  try {
    await store.addSource(OFFICIAL_MARKETPLACE_GIT_SOURCE)
    await store.addSource(community)
    const sources = await marketplace.listSources()
    expect(sources.map(({ source, managed }) => [source.url, managed])).toEqual([
      [internal.url, true]
    ])
    await expect(marketplace.addSource(community)).rejects.toThrow('turned off by your team')
    await expect(marketplace.removeSource(sources[0]!.id)).rejects.toThrow('managed by your team')

    capabilities = undefined
    expect((await marketplace.listSources()).map(({ source }) => source.url)).toEqual([
      'https://github.com/stablyai/orca-plugins.git',
      community.url
    ])
  } finally {
    await rm(pluginsDataDir, { recursive: true, force: true })
  }
})
