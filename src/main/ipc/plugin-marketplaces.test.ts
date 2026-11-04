import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../shared/constants'
import type { PluginMarketplaceInstaller } from '../plugins/catalog/plugin-marketplace-installer'
import type { PluginMarketplaceService } from '../plugins/catalog/plugin-marketplace-service'
import type { PluginService } from '../plugins/plugin-service'

type IpcHandler = (event: unknown, args?: unknown) => unknown

const electronMocks = vi.hoisted(() => ({ handle: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle: electronMocks.handle } }))

import {
  registerPluginMarketplaceHandlers,
  type PluginMarketplaceHandlerServices
} from './plugin-marketplaces'

const SOURCE_ID = 'a'.repeat(32)
const MARKETPLACE_COMMIT = 'b'.repeat(40)
const PLUGIN_COMMIT = 'c'.repeat(40)
const PLUGIN_KEY = 'samples.demo'

let handlers: Map<string, IpcHandler>

function createServices(): PluginMarketplaceHandlerServices {
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handlers read only these members.
    marketplace: {
      listSources: vi.fn().mockResolvedValue([{ id: SOURCE_ID }]),
      addSource: vi.fn().mockResolvedValue({ id: SOURCE_ID }),
      removeSource: vi.fn().mockResolvedValue(true),
      refreshSource: vi.fn().mockResolvedValue({ id: SOURCE_ID }),
      refreshAll: vi.fn().mockResolvedValue([{ id: SOURCE_ID }]),
      listPlugins: vi.fn().mockResolvedValue([{ pluginKey: PLUGIN_KEY }]),
      seedOfficialSource: vi.fn().mockResolvedValue({ id: SOURCE_ID })
    } as unknown as PluginMarketplaceService,
    installer: {
      preview: vi.fn().mockResolvedValue({ pluginKey: PLUGIN_KEY }),
      install: vi.fn().mockResolvedValue({ ok: true, pluginKey: PLUGIN_KEY }),
      previewInstalledUpdate: vi.fn().mockResolvedValue({ pluginKey: PLUGIN_KEY }),
      rollback: vi.fn().mockResolvedValue({ ok: true, pluginKey: PLUGIN_KEY })
    } as unknown as PluginMarketplaceInstaller
  }
}

function createPluginService(): PluginService {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handlers read only these members.
  return {
    options: {
      isPluginSystemEnabled: () => true,
      getPluginConsents: () => ({}),
      getDisabledPlugins: () => []
    },
    findValidPlugin: vi.fn(() => null),
    deactivatePlugin: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn().mockResolvedValue(undefined)
  } as unknown as PluginService
}

async function invoke(channel: string, args?: unknown): Promise<unknown> {
  const handler = handlers.get(channel)
  if (!handler) {
    throw new Error(`missing IPC handler: ${channel}`)
  }
  return handler({}, args)
}

beforeEach(() => {
  handlers = new Map()
  electronMocks.handle.mockReset()
  electronMocks.handle.mockImplementation((channel: string, handler: IpcHandler) => {
    handlers.set(channel, handler)
  })
})

describe('plugin marketplace IPC authority', () => {
  it('validates every mutating or plugin-selecting request strictly', async () => {
    registerPluginMarketplaceHandlers(
      createPluginService(),
      createServices(),
      () => getDefaultSettings('/tmp'),
      vi.fn()
    )

    await expect(
      invoke('plugins:addMarketplace', {
        kind: 'git',
        url: 'https://example.com/marketplace.git',
        ref: 'main',
        unexpected: true
      })
    ).rejects.toThrow()
    await expect(
      invoke('plugins:removeMarketplace', { sourceId: SOURCE_ID, unexpected: true })
    ).rejects.toThrow()
    await expect(
      invoke('plugins:refreshMarketplaces', { sourceId: 'not-a-source' })
    ).rejects.toThrow()
    await expect(
      invoke('plugins:previewMarketplacePlugin', {
        marketplaceSourceId: SOURCE_ID,
        pluginKey: '__proto__.demo'
      })
    ).rejects.toThrow()
    await expect(
      invoke('plugins:installMarketplacePlugin', {
        marketplaceSourceId: SOURCE_ID,
        marketplaceCommit: 'moving-ref',
        pluginKey: PLUGIN_KEY,
        resolvedCommit: PLUGIN_COMMIT
      })
    ).rejects.toThrow()
    await expect(
      invoke('plugins:previewMarketplaceUpdate', {
        pluginKey: PLUGIN_KEY,
        unexpected: true
      })
    ).rejects.toThrow()
    await expect(
      invoke('plugins:rollbackMarketplacePlugin', { pluginKey: 'bare-id' })
    ).rejects.toThrow()
  })

  it('dispatches source listing, add, removal, and refresh operations', async () => {
    const services = createServices()
    registerPluginMarketplaceHandlers(
      createPluginService(),
      services,
      () => getDefaultSettings('/tmp'),
      vi.fn()
    )
    const source = {
      kind: 'git' as const,
      url: 'https://example.com/marketplace.git',
      ref: 'main'
    }

    await invoke('plugins:listMarketplaces')
    await invoke('plugins:addMarketplace', source)
    await invoke('plugins:removeMarketplace', { sourceId: SOURCE_ID })
    await invoke('plugins:refreshMarketplaces', { sourceId: SOURCE_ID })
    await invoke('plugins:refreshMarketplaces', {})
    await invoke('plugins:listMarketplacePlugins')

    expect(services.marketplace.listSources).toHaveBeenCalledTimes(2)
    // The startup seed is deferred, so opening the marketplace seeds the official catalog.
    expect(services.marketplace.seedOfficialSource).toHaveBeenCalledTimes(2)
    expect(services.marketplace.addSource).toHaveBeenCalledWith(source)
    expect(services.marketplace.removeSource).toHaveBeenCalledWith(SOURCE_ID)
    expect(services.marketplace.refreshSource).toHaveBeenCalledWith(SOURCE_ID)
    expect(services.marketplace.refreshAll).toHaveBeenCalledOnce()
    expect(services.marketplace.listPlugins).toHaveBeenCalledOnce()
  })

  it('refreshes discovery only after a successful install', async () => {
    const services = createServices()
    const pluginService = createPluginService()
    registerPluginMarketplaceHandlers(
      pluginService,
      services,
      () => getDefaultSettings('/tmp'),
      vi.fn()
    )
    const preview = {
      marketplaceSourceId: SOURCE_ID,
      marketplaceCommit: MARKETPLACE_COMMIT,
      pluginKey: PLUGIN_KEY,
      resolvedCommit: PLUGIN_COMMIT
    }

    await invoke('plugins:installMarketplacePlugin', preview)
    expect(services.installer.install).toHaveBeenCalledWith(preview)
    expect(pluginService.refresh).toHaveBeenCalledOnce()

    vi.mocked(pluginService.refresh).mockClear()
    vi.mocked(services.installer.install).mockResolvedValueOnce({ ok: false, error: 'failed' })
    await invoke('plugins:installMarketplacePlugin', preview)
    expect(pluginService.refresh).not.toHaveBeenCalled()
  })

  it('deactivates before rollback and refreshes discovery only on success', async () => {
    const services = createServices()
    const pluginService = createPluginService()
    registerPluginMarketplaceHandlers(
      pluginService,
      services,
      () => getDefaultSettings('/tmp'),
      vi.fn()
    )

    await invoke('plugins:rollbackMarketplacePlugin', { pluginKey: PLUGIN_KEY })

    expect(pluginService.deactivatePlugin).toHaveBeenCalledWith(PLUGIN_KEY)
    expect(services.installer.rollback).toHaveBeenCalledWith(PLUGIN_KEY)
    expect(vi.mocked(pluginService.deactivatePlugin).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(services.installer.rollback).mock.invocationCallOrder[0]
    )
    expect(pluginService.refresh).toHaveBeenCalledOnce()

    vi.mocked(pluginService.refresh).mockClear()
    vi.mocked(services.installer.rollback).mockResolvedValueOnce({ ok: false, error: 'failed' })
    await invoke('plugins:rollbackMarketplacePlugin', { pluginKey: PLUGIN_KEY })
    expect(pluginService.refresh).not.toHaveBeenCalled()
  })

  it('turns on only content-only plugins, and only when asked, with main reading the manifest', async () => {
    const services = createServices()
    services.installer.install = vi
      .fn()
      .mockResolvedValue({ ok: true, pluginKey: PLUGIN_KEY, consentFingerprint: 'sha256-fp' })
    const execution = { value: 'data' }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only refresh and findValidPlugin.
    const pluginService = {
      ...createPluginService(),
      findValidPlugin: vi.fn(() => ({
        pluginKey: PLUGIN_KEY,
        consentFingerprint: 'sha256-fp',
        manifest: { manifestVersion: 2, execution: execution.value }
      }))
    } as unknown as PluginService
    const approve = vi.fn().mockResolvedValue(undefined)
    registerPluginMarketplaceHandlers(
      pluginService,
      services,
      () => getDefaultSettings('/tmp'),
      approve
    )
    const handler = handlers.get('plugins:installMarketplacePlugin')
    const identity = {
      marketplaceSourceId: SOURCE_ID,
      marketplaceCommit: MARKETPLACE_COMMIT,
      pluginKey: PLUGIN_KEY,
      resolvedCommit: PLUGIN_COMMIT
    }
    const event = { sender: { id: 7 } }

    await expect(handler?.(event, identity)).resolves.not.toHaveProperty('needsReview')
    expect(approve).not.toHaveBeenCalled()
    await expect(handler?.(event, { ...identity, enableIfData: true })).resolves.toMatchObject({
      needsReview: false
    })
    expect(approve).toHaveBeenCalledWith(PLUGIN_KEY, 'sha256-fp', 7)

    approve.mockClear()
    await expect(
      handler?.(event, { ...identity, enableIfData: true, expectedFingerprint: 'sha256-other' })
    ).resolves.toMatchObject({ needsReview: true })
    expect(approve).not.toHaveBeenCalled()
    await expect(
      handler?.(event, { ...identity, enableIfData: true, expectedFingerprint: 'sha256-fp' })
    ).resolves.toMatchObject({ needsReview: false })
    expect(approve).toHaveBeenCalledWith(PLUGIN_KEY, 'sha256-fp', 7)

    approve.mockClear()
    execution.value = 'declarative'
    await expect(handler?.(event, { ...identity, enableIfData: true })).resolves.toMatchObject({
      needsReview: true
    })
    expect(approve).not.toHaveBeenCalled()
  })

  it('sends an update from a moved repository to review even when one-click was asked', async () => {
    const services = createServices()
    services.installer.install = vi.fn().mockResolvedValue({
      ok: true,
      pluginKey: PLUGIN_KEY,
      consentFingerprint: 'sha256-fp',
      repositoryMoved: true
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only refresh and findValidPlugin.
    const pluginService = {
      ...createPluginService(),
      findValidPlugin: vi.fn(() => ({
        pluginKey: PLUGIN_KEY,
        consentFingerprint: 'sha256-fp',
        manifest: { manifestVersion: 2, execution: 'data' }
      }))
    } as unknown as PluginService
    const approve = vi.fn().mockResolvedValue(undefined)
    registerPluginMarketplaceHandlers(
      pluginService,
      services,
      () => getDefaultSettings('/tmp'),
      approve
    )
    const identity = {
      marketplaceSourceId: SOURCE_ID,
      marketplaceCommit: MARKETPLACE_COMMIT,
      pluginKey: PLUGIN_KEY,
      resolvedCommit: PLUGIN_COMMIT
    }
    const handler = handlers.get('plugins:installMarketplacePlugin')
    for (const args of [
      identity,
      { ...identity, enableIfData: true, expectedFingerprint: 'sha256-fp' }
    ]) {
      await expect(handler?.({ sender: { id: 7 } }, args)).resolves.toMatchObject({
        needsReview: true
      })
    }
    expect(approve).not.toHaveBeenCalled()
  })
})
