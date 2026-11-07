import { describe, expect, it, vi } from 'vitest'
import {
  pluginCatalogApprovalFingerprint,
  PluginCatalogApprovalRequiredError
} from '../../shared/plugins/approval/plugin-catalog-cli-approval'
import type { PluginMarketplaceSourceState } from './catalog/plugin-marketplace-service'
import type { PluginCliCatalogs } from './plugin-cli-catalog-candidates'
import { addPluginCatalogFromCli, removePluginCatalogFromCli } from './plugin-cli-catalogs'

function state(
  id: string,
  url: string,
  overrides: Partial<PluginMarketplaceSourceState> = {}
): PluginMarketplaceSourceState {
  return {
    id,
    source: { kind: 'git', url, ref: 'main' },
    addedAt: 1,
    marketplace: { name: id, owner: 'acme', resolvedCommit: 'a'.repeat(40), fetchedAt: 1 },
    stale: false,
    official: false,
    ...overrides
  }
}

function harness(sources: PluginMarketplaceSourceState[]) {
  const marketplace = {
    listSources: vi.fn(async () => sources),
    listPlugins: vi.fn(async () => []),
    refreshSource: vi.fn(
      async (id: string) => sources.find((source) => source.id === id) ?? state(id, '')
    ),
    refreshAll: vi.fn(async () => sources),
    addSource: vi.fn(async (source: { url: string; ref: string }) =>
      state('new-id', source.url, { source: { kind: 'git', ...source } })
    ),
    removeSource: vi.fn(async () => true)
  }
  const catalogs: PluginCliCatalogs = {
    marketplace,
    installer: {
      preview: vi.fn(),
      install: vi.fn(),
      previewInstalledUpdate: vi.fn(),
      readInstallLockfile: vi.fn()
    }
  }
  const deps = {
    catalogs,
    host: { executionHost: 'the Orca host (build-box)' },
    service: { options: { isPluginSystemEnabled: () => true } }
  }
  return { deps, marketplace }
}

describe('orca plugin catalog add', () => {
  it('needs --approve bound to the exact URL and branch, then adds it', async () => {
    const { deps, marketplace } = harness([])
    const input = { input: 'acme/orca-catalog' }
    const expected = pluginCatalogApprovalFingerprint({
      url: 'https://github.com/acme/orca-catalog',
      ref: 'main'
    })

    const required = await addPluginCatalogFromCli(deps, input).catch((error) => error)
    expect(required).toBeInstanceOf(PluginCatalogApprovalRequiredError)
    expect(required).toMatchObject({
      code: 'approval_required',
      data: { kind: 'catalog', approvalFingerprint: expected, catalog: { owner: 'acme' } }
    })
    expect(required.message).toContain('only add it if you trust acme')
    expect(marketplace.addSource).not.toHaveBeenCalled()

    await expect(
      addPluginCatalogFromCli(deps, { ...input, ref: 'release', approvalFingerprint: expected })
    ).rejects.toMatchObject({ code: 'approval_stale' })

    await expect(
      addPluginCatalogFromCli(deps, { ...input, approvalFingerprint: expected })
    ).resolves.toMatchObject({
      added: true,
      catalog: { url: 'https://github.com/acme/orca-catalog' }
    })
    expect(marketplace.addSource).toHaveBeenCalledWith({
      kind: 'git',
      url: 'https://github.com/acme/orca-catalog',
      ref: 'main'
    })
  })

  it('refreshes a catalog that is already there without asking', async () => {
    const { deps, marketplace } = harness([
      state('team', 'https://github.com/acme/orca-catalog.git')
    ])

    await expect(
      addPluginCatalogFromCli(deps, { input: 'acme/orca-catalog' })
    ).resolves.toMatchObject({
      added: false
    })
    expect(marketplace.refreshSource).toHaveBeenCalledWith('team')
  })

  it('refuses a URL that carries a token', async () => {
    const { deps } = harness([])
    await expect(
      addPluginCatalogFromCli(deps, { input: 'https://x:secret@github.com/acme/catalog' })
    ).rejects.toMatchObject({ code: 'invalid_argument' })
  })
})

describe('orca plugin catalog remove', () => {
  it('removes by name or URL but never the official catalog', async () => {
    const { deps, marketplace } = harness([
      state('official-id', 'https://github.com/stablyai/orca-plugins.git', { official: true }),
      state('team', 'https://github.com/acme/orca-catalog.git')
    ])

    await expect(removePluginCatalogFromCli(deps, 'acme/orca-catalog')).resolves.toMatchObject({
      removed: { id: 'team' }
    })
    expect(marketplace.removeSource).toHaveBeenCalledWith('team')
    await expect(removePluginCatalogFromCli(deps, 'official')).rejects.toMatchObject({
      code: 'invalid_argument'
    })
  })
})
