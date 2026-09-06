import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PluginCapabilityKind } from '../../shared/plugins/plugin-capabilities'
import { pluginManifestSchema } from '../../shared/plugins/plugin-manifest'
import { createPluginPanelCallAdmission } from '../../shared/plugins/plugin-panel-call-admission'
import type { ValidDiscoveredPlugin } from './plugin-discovery'
import { executePluginHostCall, type PluginHostServices } from './plugin-host-methods'
import { PluginPanelController } from './plugin-panel-controller'
import { PluginKvStore } from './plugin-storage-store'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function createPlugin(
  id: string,
  capabilities: PluginCapabilityKind[]
): Promise<ValidDiscoveredPlugin> {
  const rootDir = await mkdtemp(join(tmpdir(), `orca-plugin-panel-settings-${id}-`))
  roots.push(rootDir)
  await writeFile(join(rootDir, 'panel.html'), '<h1>Panel</h1>')
  return {
    pluginKey: `orca-samples.${id}`,
    rootDir,
    manifest: pluginManifestSchema.parse({
      manifestVersion: 1,
      id,
      publisher: 'orca-samples',
      name: id,
      version: '1.0.0',
      engines: { orca: '>=1.0.0' },
      pluginApi: 1,
      contributes: {
        panels: [{ id: 'dashboard', title: 'Dashboard', entry: 'panel.html' }],
        commands: [],
        events: []
      },
      capabilities: capabilities.map((kind) => ({ kind }))
    }),
    consentFingerprint: 'sha256-consented',
    contentHash: null,
    isDev: true
  }
}

function createServices(pluginsDataDir: string): PluginHostServices {
  return {
    resolveActiveWorktreeContext: vi.fn().mockResolvedValue(null),
    listWorktreeTerminals: vi.fn().mockResolvedValue([]),
    sendTerminalText: vi.fn().mockResolvedValue({ accepted: true }),
    dispatchPluginNotification: vi.fn().mockResolvedValue({ delivered: true }),
    storage: {
      get: (pluginId, key) => new PluginKvStore(pluginsDataDir, pluginId, 'storage.json').get(key),
      set: (pluginId, key, value) =>
        new PluginKvStore(pluginsDataDir, pluginId, 'storage.json').set(key, value),
      delete: (pluginId, key) =>
        new PluginKvStore(pluginsDataDir, pluginId, 'storage.json').delete(key),
      keys: (pluginId) => new PluginKvStore(pluginsDataDir, pluginId, 'storage.json').keys()
    },
    secrets: {
      get: vi.fn().mockReturnValue({ ok: true, value: null }),
      set: vi.fn().mockReturnValue({ ok: true }),
      delete: vi.fn()
    },
    settings: {
      getAll: (pluginId) => new PluginKvStore(pluginsDataDir, pluginId, 'settings.json').getAll(),
      set: (pluginId, key, value) =>
        new PluginKvStore(pluginsDataDir, pluginId, 'settings.json').set(key, value)
    },
    subscribeEvents: vi.fn().mockReturnValue([]),
    readFocusedSurface: vi.fn().mockReturnValue(null),
    sidecar: {
      resolvePlacement: vi.fn(),
      publish: vi.fn()
    }
  }
}

async function createHarness(options?: {
  capabilities?: PluginCapabilityKind[]
  otherCapabilities?: PluginCapabilityKind[]
}): Promise<{
  controller: PluginPanelController
  demo: ValidDiscoveredPlugin
  other: ValidDiscoveredPlugin
  pluginsDataDir: string
}> {
  const pluginsDataDir = await mkdtemp(join(tmpdir(), 'orca-plugin-panel-settings-data-'))
  roots.push(pluginsDataDir)
  const demo = await createPlugin('demo', options?.capabilities ?? ['settings:own'])
  const other = await createPlugin('other', options?.otherCapabilities ?? ['settings:own'])
  const plugins = new Map([
    [demo.pluginKey, demo],
    [other.pluginKey, other]
  ])
  const services = createServices(pluginsDataDir)
  const controller = new PluginPanelController({
    resolveApprovedPlugin: (pluginKey) => plugins.get(pluginKey) ?? null,
    contentVerifier: { verify: vi.fn().mockResolvedValue(undefined) },
    executeHostCall: (pluginKey, method, params) => {
      const plugin = plugins.get(pluginKey)
      return executePluginHostCall({
        pluginId: pluginKey,
        method,
        params,
        viaPanel: true,
        grantedCapabilities: plugin?.manifest.capabilities.map((cap) => cap.kind) ?? [],
        services,
        audit: { record: vi.fn().mockResolvedValue(undefined) }
      })
    },
    log: vi.fn()
  })
  return { controller, demo, other, pluginsDataDir }
}

describe('panel settings.get/set admission', () => {
  it('lets a panel read and write only its own plugin settings', async () => {
    const { controller, demo, other, pluginsDataDir } = await createHarness()
    new PluginKvStore(pluginsDataDir, other.pluginKey, 'settings.json').set('secret', 'nope')
    const entry = await controller.open('runtime:one', demo.pluginKey, 'dashboard')
    expect(entry).not.toBeNull()

    await expect(
      controller.execute('runtime:one', {
        sessionToken: entry!.sessionToken,
        action: 'settings.set',
        params: { key: 'theme', value: 'dark' }
      })
    ).resolves.toEqual({ ok: true, value: { ok: true } })
    await expect(
      controller.execute('runtime:one', {
        sessionToken: entry!.sessionToken,
        action: 'settings.get'
      })
    ).resolves.toEqual({ ok: true, value: { settings: { theme: 'dark' } } })

    expect(new PluginKvStore(pluginsDataDir, demo.pluginKey, 'settings.json').getAll()).toEqual({
      theme: 'dark'
    })
    expect(new PluginKvStore(pluginsDataDir, other.pluginKey, 'settings.json').getAll()).toEqual({
      secret: 'nope'
    })
  })

  it('rejects caller-supplied plugin identity and never writes the other plugin', async () => {
    const { controller, demo, other, pluginsDataDir } = await createHarness()
    const entry = await controller.open('runtime:one', demo.pluginKey, 'dashboard')

    await expect(
      controller.execute('runtime:one', {
        sessionToken: entry!.sessionToken,
        pluginId: other.pluginKey,
        action: 'settings.set',
        params: { key: 'theme', value: 'dark' }
      })
    ).resolves.toMatchObject({ ok: false, code: 'invalid_request' })
    expect(new PluginKvStore(pluginsDataDir, other.pluginKey, 'settings.json').getAll()).toEqual({})
    expect(new PluginKvStore(pluginsDataDir, demo.pluginKey, 'settings.json').getAll()).toEqual({})
  })

  it('denies panel settings without settings:own and storage without storage', async () => {
    const { controller, demo } = await createHarness({ capabilities: ['notifications:show'] })
    const entry = await controller.open('runtime:one', demo.pluginKey, 'dashboard')

    await expect(
      controller.execute('runtime:one', {
        sessionToken: entry!.sessionToken,
        action: 'settings.get'
      })
    ).resolves.toMatchObject({ ok: false, code: 'capability_denied' })
    await expect(
      controller.execute('runtime:one', {
        sessionToken: entry!.sessionToken,
        action: 'storage.get',
        params: { key: 'alpha' }
      })
    ).resolves.toMatchObject({ ok: false, code: 'capability_denied' })
  })

  it('charges oversized settings writes against the panel message budget', async () => {
    const pluginsDataDir = await mkdtemp(join(tmpdir(), 'orca-plugin-panel-settings-budget-'))
    roots.push(pluginsDataDir)
    const demo = await createPlugin('demo', ['settings:own'])
    const services = createServices(pluginsDataDir)
    const settingsSet = vi.fn().mockReturnValue({ ok: true as const })
    services.settings.set = settingsSet
    const controller = new PluginPanelController({
      resolveApprovedPlugin: (pluginKey) => (pluginKey === demo.pluginKey ? demo : null),
      contentVerifier: { verify: vi.fn().mockResolvedValue(undefined) },
      executeHostCall: (pluginKey, method, params) =>
        executePluginHostCall({
          pluginId: pluginKey,
          method,
          params,
          viaPanel: true,
          grantedCapabilities: ['settings:own'],
          services,
          audit: { record: vi.fn().mockResolvedValue(undefined) }
        }),
      log: vi.fn(),
      panelAdmission: createPluginPanelCallAdmission({
        limits: { maxBytes: 128, maxMessages: 2, perMs: 10_000 },
        now: () => 0
      })
    })
    const entry = await controller.open('runtime:one', demo.pluginKey, 'dashboard')

    await expect(
      controller.execute('runtime:one', {
        sessionToken: entry!.sessionToken,
        action: 'settings.get'
      })
    ).resolves.toMatchObject({ ok: true })
    await expect(
      controller.execute('runtime:one', {
        sessionToken: entry!.sessionToken,
        action: 'settings.set',
        params: { key: 'blob', value: 'x'.repeat(256) }
      })
    ).resolves.toEqual({
      ok: false,
      code: 'invalid_request',
      error: 'panel message exceeds the size limit'
    })
    await expect(
      controller.execute('runtime:one', {
        sessionToken: entry!.sessionToken,
        action: 'settings.set',
        params: { key: 'theme', value: 'dark' }
      })
    ).resolves.toEqual({
      ok: false,
      code: 'rate_limited',
      error: 'too many panel requests'
    })
    expect(settingsSet).not.toHaveBeenCalled()
  })
})
