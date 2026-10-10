import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { pluginManifestSchema } from '../../shared/plugins/plugin-manifest'
import { createPluginPanelCallAdmission } from '../../shared/plugins/plugin-panel-call-admission'
import type { ValidDiscoveredPlugin } from './plugin-discovery'
import { PluginPanelController } from './plugin-panel-controller'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function createPlugin(): Promise<ValidDiscoveredPlugin> {
  const rootDir = await mkdtemp(join(tmpdir(), 'orca-plugin-panel-controller-'))
  roots.push(rootDir)
  await writeFile(join(rootDir, 'panel.html'), '<h1>Panel</h1>')
  return {
    pluginKey: 'orca-samples.demo',
    rootDir,
    manifest: pluginManifestSchema.parse({
      manifestVersion: 1,
      id: 'demo',
      publisher: 'orca-samples',
      name: 'Demo',
      version: '1.0.0',
      engines: { orca: '>=1.0.0' },
      pluginApi: 1,
      contributes: {
        panels: [{ id: 'dashboard', title: 'Dashboard', entry: 'panel.html' }],
        commands: [],
        events: []
      },
      capabilities: [{ kind: 'notifications:show' }]
    }),
    consentFingerprint: 'sha256-consented',
    contentHash: null,
    isDev: true
  }
}

describe('PluginPanelController identity binding', () => {
  it('uses the session identity and rejects caller-supplied plugin claims', async () => {
    const plugin = await createPlugin()
    const executeHostCall = vi.fn().mockResolvedValue({ ok: true, value: { delivered: true } })
    const controller = new PluginPanelController({
      resolveApprovedPlugin: (pluginKey) => (pluginKey === plugin.pluginKey ? plugin : null),
      contentVerifier: { verify: vi.fn().mockResolvedValue(undefined) },
      executeHostCall,
      log: () => vi.fn()
    })
    const entry = await controller.open('runtime:one', plugin.pluginKey, 'dashboard')
    expect(entry).not.toBeNull()

    await expect(
      controller.execute('runtime:one', {
        sessionToken: entry!.sessionToken,
        pluginId: 'orca-samples.other',
        action: 'notifications.show',
        params: { title: 'Hello' }
      })
    ).resolves.toMatchObject({ ok: false, code: 'invalid_request' })
    expect(executeHostCall).not.toHaveBeenCalled()

    await expect(
      controller.execute('runtime:one', {
        sessionToken: entry!.sessionToken,
        action: 'notifications.show',
        params: { title: 'Hello' }
      })
    ).resolves.toMatchObject({ ok: true })
    expect(executeHostCall).toHaveBeenCalledWith(
      plugin.pluginKey,
      'notifications.show',
      { title: 'Hello' },
      false
    )
    await expect(
      controller.execute('runtime:other', {
        sessionToken: entry!.sessionToken,
        action: 'notifications.show',
        params: { title: 'Hello' }
      })
    ).resolves.toMatchObject({ ok: false, code: 'invalid_request' })
  })

  it('charges raw malformed and oversized calls before strict parsing', async () => {
    const plugin = await createPlugin()
    const executeHostCall = vi.fn()
    const controller = new PluginPanelController({
      resolveApprovedPlugin: () => plugin,
      contentVerifier: { verify: vi.fn().mockResolvedValue(undefined) },
      executeHostCall,
      log: () => vi.fn(),
      panelAdmission: createPluginPanelCallAdmission({
        limits: { maxBytes: 128, maxMessages: 2, perMs: 10_000 },
        now: () => 0
      })
    })
    const entry = await controller.open('runtime:one', plugin.pluginKey, 'dashboard')

    await expect(
      controller.execute('runtime:one', {
        sessionToken: entry!.sessionToken,
        action: 'notifications.show',
        unexpected: true
      })
    ).resolves.toMatchObject({ ok: false, code: 'invalid_request' })
    await expect(
      controller.execute('runtime:one', {
        sessionToken: entry!.sessionToken,
        action: 'notifications.show',
        params: { title: 'x'.repeat(256) }
      })
    ).resolves.toEqual({
      ok: false,
      code: 'invalid_request',
      error: 'panel message exceeds the size limit'
    })
    await expect(
      controller.execute('runtime:one', {
        sessionToken: entry!.sessionToken,
        action: 'notifications.show',
        params: { title: 'third' }
      })
    ).resolves.toEqual({
      ok: false,
      code: 'rate_limited',
      error: 'too many panel requests'
    })
    expect(executeHostCall).not.toHaveBeenCalled()
  })

  it('does not publish stale panel code after approval changes during verification', async () => {
    const plugin = await createPlugin()
    let approved = true
    let finishVerification!: () => void
    const verification = new Promise<void>((resolve) => {
      finishVerification = resolve
    })
    const controller = new PluginPanelController({
      resolveApprovedPlugin: () => (approved ? plugin : null),
      contentVerifier: { verify: () => verification },
      executeHostCall: vi.fn(),
      log: () => vi.fn()
    })

    const opening = controller.open('runtime:one', plugin.pluginKey, 'dashboard')
    approved = false
    finishVerification()

    await expect(opening).resolves.toBeNull()
  })

  it('invalidates an open dev-panel session when its manifest revision changes', async () => {
    const plugin = await createPlugin()
    let current = plugin
    const executeHostCall = vi.fn().mockResolvedValue({ ok: true, value: { delivered: true } })
    const controller = new PluginPanelController({
      resolveApprovedPlugin: () => current,
      contentVerifier: { verify: vi.fn().mockResolvedValue(undefined) },
      executeHostCall,
      log: () => vi.fn()
    })
    const entry = await controller.open('runtime:one', plugin.pluginKey, 'dashboard')
    current = {
      ...plugin,
      manifest: pluginManifestSchema.parse({ ...plugin.manifest, version: '1.0.1' })
    }

    await expect(
      controller.execute('runtime:one', {
        sessionToken: entry!.sessionToken,
        action: 'notifications.show',
        params: { title: 'Hello' }
      })
    ).resolves.toMatchObject({ ok: false, code: 'unavailable' })
    expect(executeHostCall).not.toHaveBeenCalled()
  })
})

describe('PluginPanelController settings page surface', () => {
  async function createSettingsPagePlugin(): Promise<ValidDiscoveredPlugin> {
    const plugin = await createPlugin()
    await writeFile(join(plugin.rootDir, 'settings.html'), '<h1>Settings</h1>')
    return {
      ...plugin,
      manifest: pluginManifestSchema.parse({
        ...plugin.manifest,
        contributes: {
          ...plugin.manifest.contributes,
          settingsPages: [{ id: 'preferences', title: 'Preferences', entry: 'settings.html' }]
        },
        capabilities: [{ kind: 'settingsPage' }, { kind: 'settings:own' }]
      })
    }
  }

  it('opens settings pages as their own surface and marks their calls', async () => {
    const plugin = await createSettingsPagePlugin()
    const executeHostCall = vi.fn().mockResolvedValue({ ok: true, value: { ok: true } })
    const controller = new PluginPanelController({
      resolveApprovedPlugin: () => plugin,
      contentVerifier: { verify: vi.fn().mockResolvedValue(undefined) },
      executeHostCall,
      log: () => vi.fn()
    })

    const page = await controller.open(
      'renderer:1',
      plugin.pluginKey,
      'preferences',
      'settingsPage'
    )
    expect(page?.html).toContain('<h1>Settings</h1>')
    // Ids resolve only within their own surface.
    await expect(controller.open('renderer:1', plugin.pluginKey, 'preferences')).resolves.toBeNull()
    await expect(
      controller.open('renderer:1', plugin.pluginKey, 'dashboard', 'settingsPage')
    ).resolves.toBeNull()

    const panel = await controller.open('renderer:1', plugin.pluginKey, 'dashboard')
    expect(panel?.sessionToken).not.toBe(page?.sessionToken)
    const call = { action: 'settings.set', params: { key: 'greeting', value: 'Hi' } }
    await controller.execute('renderer:1', { sessionToken: page!.sessionToken, ...call })
    await controller.execute('renderer:1', { sessionToken: panel!.sessionToken, ...call })
    expect(executeHostCall).toHaveBeenNthCalledWith(
      1,
      plugin.pluginKey,
      'settings.set',
      call.params,
      true
    )
    expect(executeHostCall).toHaveBeenNthCalledWith(
      2,
      plugin.pluginKey,
      'settings.set',
      call.params,
      false
    )
  })

  it('stops a settings page session once the page leaves the manifest', async () => {
    let plugin = await createSettingsPagePlugin()
    const executeHostCall = vi.fn()
    const controller = new PluginPanelController({
      resolveApprovedPlugin: () => plugin,
      contentVerifier: { verify: vi.fn().mockResolvedValue(undefined) },
      executeHostCall,
      log: () => vi.fn()
    })
    const page = await controller.open(
      'renderer:1',
      plugin.pluginKey,
      'preferences',
      'settingsPage'
    )
    plugin = await createPlugin()

    await expect(
      controller.execute('renderer:1', {
        sessionToken: page!.sessionToken,
        action: 'settings.get',
        params: {}
      })
    ).resolves.toMatchObject({ ok: false, code: 'unavailable' })
    expect(executeHostCall).not.toHaveBeenCalled()
  })
})
