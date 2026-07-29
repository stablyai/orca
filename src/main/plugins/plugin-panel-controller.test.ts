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
      log: vi.fn()
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
    expect(executeHostCall).toHaveBeenCalledWith(plugin.pluginKey, 'notifications.show', {
      title: 'Hello'
    })
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
      log: vi.fn(),
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
      log: vi.fn()
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
      log: vi.fn()
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
