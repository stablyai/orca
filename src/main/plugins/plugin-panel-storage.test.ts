import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PANEL_MESSAGE_MAX_BYTES } from '../../shared/plugins/plugin-panel-bridge'
import { createPluginPanelCallAdmission } from '../../shared/plugins/plugin-panel-call-admission'
import { pluginManifestSchema } from '../../shared/plugins/plugin-manifest'
import type { ValidDiscoveredPlugin } from './plugin-discovery'
import { executePluginHostCall } from './plugin-host-methods'
import { bindPluginHostServices } from './plugin-host-service-bindings'
import { PluginPanelController } from './plugin-panel-controller'
import { PluginKvStore } from './plugin-storage-store'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function createPanelPlugin(
  pluginKey: 'orca-samples.demo' | 'orca-samples.other'
): Promise<ValidDiscoveredPlugin> {
  const rootDir = await mkdtemp(join(tmpdir(), 'orca-plugin-panel-storage-'))
  roots.push(rootDir)
  await writeFile(join(rootDir, 'panel.html'), '<h1>Panel</h1>')
  const [, id] = pluginKey.split('.')
  return {
    pluginKey,
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
      capabilities: [{ kind: 'storage' }]
    }),
    consentFingerprint: 'sha256-consented',
    contentHash: null,
    isDev: true
  }
}

function createRuntimeServices(pluginsDataDir: string) {
  return bindPluginHostServices({
    delegate: {
      resolveActiveWorktreeContext: vi.fn().mockResolvedValue(null),
      listTerminals: vi.fn().mockResolvedValue({ terminals: [] }),
      sendTerminal: vi.fn().mockResolvedValue({ accepted: true }),
      dispatchPluginNotification: vi.fn().mockResolvedValue({ delivered: true })
    },
    pluginsDataDir,
    subscribeEvents: vi.fn().mockReturnValue([])
  })
}

describe('panel-callable storage.*', () => {
  it('lets a panel read and write a worker snapshot in its own store only', async () => {
    const pluginsDataDir = await mkdtemp(join(tmpdir(), 'orca-plugin-data-'))
    roots.push(pluginsDataDir)
    const demo = await createPanelPlugin('orca-samples.demo')
    const other = await createPanelPlugin('orca-samples.other')
    const plugins = new Map([
      [demo.pluginKey, demo],
      [other.pluginKey, other]
    ])
    const services = createRuntimeServices(pluginsDataDir)
    const audit = { record: vi.fn().mockResolvedValue(undefined) }
    const controller = new PluginPanelController({
      resolveApprovedPlugin: (pluginKey) => plugins.get(pluginKey) ?? null,
      contentVerifier: { verify: vi.fn().mockResolvedValue(undefined) },
      executeHostCall: (pluginKey, method, params) =>
        executePluginHostCall({
          pluginId: pluginKey,
          method,
          params,
          viaPanel: true,
          grantedCapabilities: ['storage'],
          services,
          audit
        }),
      log: vi.fn()
    })

    const workerSnapshot = {
      lines: ['heartbeat ok', 'discord connected'],
      updatedAt: 1_700_000_000_000
    }
    expect(
      await executePluginHostCall({
        pluginId: demo.pluginKey,
        method: 'storage.set',
        params: { key: 'diagnostics.snapshot', value: workerSnapshot },
        viaPanel: false,
        grantedCapabilities: ['storage'],
        services,
        audit
      })
    ).toEqual({ ok: true, value: { ok: true } })

    const demoEntry = await controller.open('runtime:one', demo.pluginKey, 'dashboard')
    const otherEntry = await controller.open('runtime:one', other.pluginKey, 'dashboard')
    expect(demoEntry).not.toBeNull()
    expect(otherEntry).not.toBeNull()

    await expect(
      controller.execute('runtime:one', {
        sessionToken: demoEntry!.sessionToken,
        action: 'storage.get',
        params: { key: 'diagnostics.snapshot' }
      })
    ).resolves.toEqual({ ok: true, value: { value: workerSnapshot } })

    await expect(
      controller.execute('runtime:one', {
        sessionToken: otherEntry!.sessionToken,
        action: 'storage.get',
        params: { key: 'diagnostics.snapshot' }
      })
    ).resolves.toEqual({ ok: true, value: { value: null } })

    await expect(
      controller.execute('runtime:one', {
        sessionToken: demoEntry!.sessionToken,
        pluginId: other.pluginKey,
        action: 'storage.set',
        params: { key: 'diagnostics.snapshot', value: { hijack: true } }
      })
    ).resolves.toMatchObject({ ok: false, code: 'invalid_request' })

    expect(
      new PluginKvStore(pluginsDataDir, demo.pluginKey, 'storage.json').get('diagnostics.snapshot')
    ).toEqual(workerSnapshot)
    expect(
      new PluginKvStore(pluginsDataDir, other.pluginKey, 'storage.json').get('diagnostics.snapshot')
    ).toBeUndefined()
  })

  it('lets the owning panel mutate its own keys and list them', async () => {
    const pluginsDataDir = await mkdtemp(join(tmpdir(), 'orca-plugin-data-'))
    roots.push(pluginsDataDir)
    const demo = await createPanelPlugin('orca-samples.demo')
    const services = createRuntimeServices(pluginsDataDir)
    const audit = { record: vi.fn().mockResolvedValue(undefined) }
    const controller = new PluginPanelController({
      resolveApprovedPlugin: (pluginKey) => (pluginKey === demo.pluginKey ? demo : null),
      contentVerifier: { verify: vi.fn().mockResolvedValue(undefined) },
      executeHostCall: (pluginKey, method, params) =>
        executePluginHostCall({
          pluginId: pluginKey,
          method,
          params,
          viaPanel: true,
          grantedCapabilities: ['storage'],
          services,
          audit
        }),
      log: vi.fn()
    })
    const entry = await controller.open('runtime:one', demo.pluginKey, 'dashboard')

    await expect(
      controller.execute('runtime:one', {
        sessionToken: entry!.sessionToken,
        action: 'storage.set',
        params: { key: 'ui.draft', value: { open: true } }
      })
    ).resolves.toEqual({ ok: true, value: { ok: true } })
    await expect(
      controller.execute('runtime:one', {
        sessionToken: entry!.sessionToken,
        action: 'storage.keys',
        params: {}
      })
    ).resolves.toEqual({ ok: true, value: { keys: ['ui.draft'] } })
    await expect(
      controller.execute('runtime:one', {
        sessionToken: entry!.sessionToken,
        action: 'storage.delete',
        params: { key: 'ui.draft' }
      })
    ).resolves.toEqual({ ok: true, value: { ok: true } })
    await expect(
      controller.execute('runtime:one', {
        sessionToken: entry!.sessionToken,
        action: 'storage.get',
        params: { key: 'ui.draft' }
      })
    ).resolves.toEqual({ ok: true, value: { value: null } })
    expect(audit.record).toHaveBeenCalled()
  })

  it('refuses an oversized panel storage.set before touching the store', async () => {
    const pluginsDataDir = await mkdtemp(join(tmpdir(), 'orca-plugin-data-'))
    roots.push(pluginsDataDir)
    const demo = await createPanelPlugin('orca-samples.demo')
    const executeHostCall = vi.fn()
    const controller = new PluginPanelController({
      resolveApprovedPlugin: () => demo,
      contentVerifier: { verify: vi.fn().mockResolvedValue(undefined) },
      executeHostCall,
      log: vi.fn(),
      panelAdmission: createPluginPanelCallAdmission({
        limits: { maxBytes: 128, maxMessages: 4, perMs: 10_000 },
        now: () => 0
      })
    })
    const entry = await controller.open('runtime:one', demo.pluginKey, 'dashboard')

    await expect(
      controller.execute('runtime:one', {
        sessionToken: entry!.sessionToken,
        action: 'storage.set',
        params: { key: 'diagnostics.snapshot', value: 'x'.repeat(256) }
      })
    ).resolves.toEqual({
      ok: false,
      code: 'invalid_request',
      error: 'panel message exceeds the size limit'
    })
    expect(executeHostCall).not.toHaveBeenCalled()
    expect(new PluginKvStore(pluginsDataDir, demo.pluginKey, 'storage.json').keys()).toEqual([])
  })

  it('refuses a panel storage.get whose result exceeds the panel message budget', async () => {
    const pluginsDataDir = await mkdtemp(join(tmpdir(), 'orca-plugin-data-'))
    roots.push(pluginsDataDir)
    const demo = await createPanelPlugin('orca-samples.demo')
    const services = createRuntimeServices(pluginsDataDir)
    const audit = { record: vi.fn().mockResolvedValue(undefined) }
    const oversized = 'y'.repeat(PANEL_MESSAGE_MAX_BYTES + 1)
    expect(
      await executePluginHostCall({
        pluginId: demo.pluginKey,
        method: 'storage.set',
        params: { key: 'diagnostics.snapshot', value: oversized },
        viaPanel: false,
        grantedCapabilities: ['storage'],
        services,
        audit
      })
    ).toEqual({ ok: true, value: { ok: true } })

    const panelGet = await executePluginHostCall({
      pluginId: demo.pluginKey,
      method: 'storage.get',
      params: { key: 'diagnostics.snapshot' },
      viaPanel: true,
      grantedCapabilities: ['storage'],
      services,
      audit
    })
    expect(panelGet).toEqual({
      ok: false,
      code: 'invalid_request',
      error: 'panel message exceeds the size limit'
    })

    const workerGet = await executePluginHostCall({
      pluginId: demo.pluginKey,
      method: 'storage.get',
      params: { key: 'diagnostics.snapshot' },
      viaPanel: false,
      grantedCapabilities: ['storage'],
      services,
      audit
    })
    expect(workerGet).toEqual({ ok: true, value: { value: oversized } })
  })
})
