import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { pluginManifestSchema } from '../../../shared/plugins/manifest/plugin-manifest'
import { createPluginPanelCallAdmission } from '../../../shared/plugins/frames/plugin-panel-call-admission'
import type { ValidDiscoveredPlugin } from '../plugin-discovery'
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
    pluginKey: 'samples.demo',
    rootDir,
    manifest: pluginManifestSchema.parse({
      manifestVersion: 1,
      id: 'demo',
      publisher: 'samples',
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
      ensureWorker: vi.fn(),
      log: () => vi.fn()
    })
    const entry = await controller.open('runtime:one', plugin.pluginKey, 'dashboard')
    expect(entry).not.toBeNull()

    await expect(
      controller.execute('runtime:one', {
        sessionToken: entry!.sessionToken,
        pluginId: 'samples.other',
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
      'panel'
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
      ensureWorker: vi.fn(),
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
      code: 'too_large',
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
      ensureWorker: vi.fn(),
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
      ensureWorker: vi.fn(),
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

describe('PluginPanelController panel messages to the worker', () => {
  async function open(
    options: Partial<ConstructorParameters<typeof PluginPanelController>[0]> = {}
  ) {
    const base = await createPlugin()
    const plugin = { ...base, manifest: { ...base.manifest, main: 'worker.mjs' } }
    const other = { ...plugin, pluginKey: 'samples.other' }
    const executeHostCall = vi.fn()
    const deliverPanelMessage = vi.fn().mockResolvedValue({ ok: true, value: { playing: true } })
    const ensureWorker = vi.fn().mockResolvedValue({ deliverPanelMessage })
    let approved = true
    const controller = new PluginPanelController({
      resolveApprovedPlugin: (pluginKey) => {
        if (!approved) {
          return null
        }
        return pluginKey === plugin.pluginKey
          ? plugin
          : pluginKey === other.pluginKey
            ? other
            : null
      },
      contentVerifier: { verify: vi.fn().mockResolvedValue(undefined) },
      executeHostCall,
      ensureWorker,
      log: () => vi.fn(),
      ...options
    })
    const entry = await controller.open('runtime:one', plugin.pluginKey, 'dashboard')
    const post = (params: unknown) =>
      controller.execute('runtime:one', {
        sessionToken: entry!.sessionToken,
        action: 'panel.postMessage',
        params
      })
    return {
      plugin,
      controller,
      executeHostCall,
      ensureWorker,
      deliverPanelMessage,
      post,
      revokeApproval: () => {
        approved = false
      }
    }
  }

  it('delivers to the session plugin and panel even when the message names others', async () => {
    const { plugin, ensureWorker, deliverPanelMessage, executeHostCall, post } = await open()
    const forged = { pluginKey: 'samples.other', panelId: 'admin', sessionToken: 'x'.repeat(43) }

    await expect(post(forged)).resolves.toEqual({ ok: true, value: { playing: true } })

    expect(ensureWorker).toHaveBeenCalledOnce()
    expect(ensureWorker).toHaveBeenCalledWith(plugin)
    expect(deliverPanelMessage).toHaveBeenCalledOnce()
    expect(deliverPanelMessage).toHaveBeenCalledWith('dashboard', forged)
    expect(executeHostCall).not.toHaveBeenCalled()
  })

  it('refuses an oversized message before it reaches the worker', async () => {
    const { ensureWorker, post } = await open({
      panelAdmission: createPluginPanelCallAdmission({
        limits: { maxBytes: 256, maxMessages: 10, perMs: 10_000 },
        now: () => 0
      })
    })

    await expect(post({ data: 'x'.repeat(512) })).resolves.toMatchObject({
      ok: false,
      code: 'too_large'
    })
    expect(ensureWorker).not.toHaveBeenCalled()
  })

  it('refuses a flood once the plugin budget is spent, and delivers again after the window', async () => {
    let now = 0
    const { deliverPanelMessage, post } = await open({
      panelAdmission: createPluginPanelCallAdmission({
        limits: { maxMessages: 3, perMs: 10_000 },
        now: () => now
      })
    })

    for (let index = 0; index < 3; index += 1) {
      await expect(post({ index })).resolves.toMatchObject({ ok: true })
    }
    await expect(post({ index: 3 })).resolves.toMatchObject({ ok: false, code: 'rate_limited' })
    expect(deliverPanelMessage).toHaveBeenCalledTimes(3)
    now = 10_000
    await expect(post({ index: 4 })).resolves.toMatchObject({ ok: true })
  })

  it('does not deliver once approval is withdrawn or the session is revoked', async () => {
    const { controller, ensureWorker, post, revokeApproval } = await open()
    revokeApproval()
    await expect(post({})).resolves.toMatchObject({ ok: false, code: 'unavailable' })

    controller.revokeOwner('runtime:one')
    await expect(post({})).resolves.toMatchObject({ ok: false, code: 'invalid_request' })
    expect(ensureWorker).not.toHaveBeenCalled()
  })
})
