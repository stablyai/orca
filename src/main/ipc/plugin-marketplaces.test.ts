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
      seedOfficialSource: vi.fn().mockResolvedValue({ id: SOURCE_ID }),
      seedCommunitySource: vi.fn().mockResolvedValue(undefined)
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

beforeEach(() => {
  handlers = new Map()
  electronMocks.handle.mockReset()
  electronMocks.handle.mockImplementation((channel: string, handler: IpcHandler) => {
    handlers.set(channel, handler)
  })
})

describe('plugin marketplace IPC authority', () => {
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
    expect(approve).toHaveBeenCalledWith(PLUGIN_KEY, 'sha256-fp')

    approve.mockClear()
    await expect(
      handler?.(event, { ...identity, enableIfData: true, expectedFingerprint: 'sha256-other' })
    ).resolves.toMatchObject({ needsReview: true })
    expect(approve).not.toHaveBeenCalled()
    await expect(
      handler?.(event, { ...identity, enableIfData: true, expectedFingerprint: 'sha256-fp' })
    ).resolves.toMatchObject({ needsReview: false })
    expect(approve).toHaveBeenCalledWith(PLUGIN_KEY, 'sha256-fp')

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
