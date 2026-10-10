import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { pluginManifestSchema } from '../../shared/plugins/plugin-manifest'
import { PANEL_LIVE_MESSAGE_RATE_LIMIT } from '../../shared/plugins/plugin-panel-live-message'
import type { ValidDiscoveredPlugin } from './plugin-discovery'
import type { PluginWorkerHandle } from './plugin-host-process'
import { PluginClientSurfaces } from './plugin-client-surfaces'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function createPlugin(
  pluginKey: string,
  capabilities: string[] = ['panelMessaging']
): Promise<ValidDiscoveredPlugin> {
  const rootDir = await mkdtemp(join(tmpdir(), 'orca-plugin-live-channel-'))
  roots.push(rootDir)
  await writeFile(join(rootDir, 'panel.html'), '<h1>Panel</h1>')
  const [publisher, id] = pluginKey.split('.')
  return {
    pluginKey,
    rootDir,
    manifest: pluginManifestSchema.parse({
      manifestVersion: 1,
      id,
      publisher,
      name: id,
      version: '1.0.0',
      engines: { orca: '>=1.0.0' },
      pluginApi: 1,
      main: 'main.mjs',
      contributes: {
        panels: [
          { id: 'live', title: 'Live', entry: 'panel.html' },
          { id: 'other', title: 'Other', entry: 'panel.html' }
        ]
      },
      capabilities: capabilities.map((kind) => ({ kind }))
    }),
    consentFingerprint: 'sha256-consented',
    contentHash: null,
    isDev: true
  }
}

function workerHandle(): PluginWorkerHandle {
  return {
    commands: [],
    invokeCommand: vi.fn(async () => null),
    deliverEvent: vi.fn(),
    deliverPanelMessage: vi.fn(() => true),
    lastActivityAt: () => Date.now(),
    inFlightCount: () => 0,
    dispose: vi.fn(async () => undefined),
    kill: vi.fn(),
    onExit: vi.fn()
  }
}

function createSurfaces(plugins: ValidDiscoveredPlugin[]) {
  const approved = new Map(plugins.map((plugin) => [plugin.pluginKey, plugin]))
  const handle = workerHandle()
  const ensureWorker = vi.fn().mockResolvedValue(handle)
  const surfaces = new PluginClientSurfaces({
    resolveApprovedPlugin: (key) => approved.get(key) ?? null,
    ensureWorker,
    contentVerifier: { verify: vi.fn().mockResolvedValue(undefined) },
    executeHostCall: vi.fn().mockResolvedValue({ ok: true, value: null }),
    log: () => vi.fn()
  })
  return { surfaces, panels: surfaces.panels, approved, handle, ensureWorker }
}

describe('live panel channel', () => {
  it('delivers worker messages only to mounted frames of the owning plugin and panel', async () => {
    const live = await createPlugin('orca-samples.live')
    const other = await createPlugin('orca-samples.other')
    const { panels } = createSurfaces([live, other])
    const liveEntry = await panels.open('renderer:1', live.pluginKey, 'live')
    const otherPanelEntry = await panels.open('renderer:1', live.pluginKey, 'other')
    const otherPluginEntry = await panels.open('renderer:1', other.pluginKey, 'live')
    const deliveries = { live: vi.fn(), otherPanel: vi.fn(), otherPlugin: vi.fn() }
    expect(
      panels.attach('renderer:1', { sessionToken: liveEntry!.sessionToken }, deliveries.live)
    ).toBe(true)
    panels.attach(
      'renderer:1',
      { sessionToken: otherPanelEntry!.sessionToken },
      deliveries.otherPanel
    )
    panels.attach(
      'renderer:1',
      { sessionToken: otherPluginEntry!.sessionToken },
      deliveries.otherPlugin
    )

    expect(panels.postToPanel(live.pluginKey, 'live', { tick: 1 })).toEqual({
      ok: true,
      delivered: true
    })
    expect(deliveries.live).toHaveBeenCalledWith({
      sessionToken: liveEntry!.sessionToken,
      message: { tick: 1 }
    })
    expect(deliveries.otherPanel).not.toHaveBeenCalled()
    expect(deliveries.otherPlugin).not.toHaveBeenCalled()
  })

  it('drops messages for panels that are not mounted and rejects undeclared panels', async () => {
    const live = await createPlugin('orca-samples.live')
    const { panels } = createSurfaces([live])
    const entry = await panels.open('renderer:1', live.pluginKey, 'live')
    const deliver = vi.fn()

    expect(panels.postToPanel(live.pluginKey, 'live', 1)).toEqual({ ok: true, delivered: false })
    panels.attach('renderer:1', { sessionToken: entry!.sessionToken }, deliver)
    panels.attach('renderer:1', { sessionToken: entry!.sessionToken }, deliver)
    panels.detach('renderer:1', { sessionToken: entry!.sessionToken })
    // Ref-counted: one of two frames for the session is still mounted.
    expect(panels.postToPanel(live.pluginKey, 'live', 2)).toEqual({ ok: true, delivered: true })
    panels.detach('renderer:1', { sessionToken: entry!.sessionToken })
    expect(panels.postToPanel(live.pluginKey, 'live', 3)).toEqual({ ok: true, delivered: false })
    expect(panels.postToPanel(live.pluginKey, 'missing', 4)).toEqual({
      ok: false,
      error: 'unknown panel: missing'
    })
    expect(deliver).toHaveBeenCalledTimes(1)
  })

  it('refuses attach for another owner or an unknown session, and revokes with the owner', async () => {
    const live = await createPlugin('orca-samples.live')
    const { panels } = createSurfaces([live])
    const entry = await panels.open('renderer:1', live.pluginKey, 'live')
    const deliver = vi.fn()

    expect(panels.attach('renderer:2', { sessionToken: entry!.sessionToken }, deliver)).toBe(false)
    expect(panels.attach('renderer:1', { sessionToken: 'x'.repeat(43) }, deliver)).toBe(false)
    expect(
      panels.attach('renderer:1', { sessionToken: entry!.sessionToken, pluginKey: 'a.b' }, deliver)
    ).toBe(false)
    expect(panels.attach('renderer:1', { sessionToken: entry!.sessionToken }, deliver)).toBe(true)
    panels.revokeOwner('renderer:1')
    expect(panels.postToPanel(live.pluginKey, 'live', 1)).toEqual({ ok: true, delivered: false })
  })

  it('rate limits worker pushes per plugin', async () => {
    const live = await createPlugin('orca-samples.live')
    const { panels } = createSurfaces([live])
    for (let index = 0; index < PANEL_LIVE_MESSAGE_RATE_LIMIT.maxMessages; index += 1) {
      expect(panels.postToPanel(live.pluginKey, 'live', index)).toMatchObject({ ok: true })
    }
    expect(panels.postToPanel(live.pluginKey, 'live', 'one too many')).toEqual({
      ok: false,
      error: 'too many panel messages'
    })
  })

  it('routes panel messages to the worker under the session identity', async () => {
    const live = await createPlugin('orca-samples.live')
    const { panels, handle, ensureWorker } = createSurfaces([live])
    const entry = await panels.open('renderer:1', live.pluginKey, 'live')

    await expect(
      panels.receiveFromPanel('renderer:1', {
        sessionToken: entry!.sessionToken,
        message: { type: 'ready', at: new Date(0) }
      })
    ).resolves.toEqual({ ok: true, value: { delivered: true } })
    expect(ensureWorker).toHaveBeenCalledWith(live)
    expect(handle.deliverPanelMessage).toHaveBeenCalledWith('live', {
      type: 'ready',
      at: '1970-01-01T00:00:00.000Z'
    })
  })

  it.each([
    ['another owner', 'renderer:2', {}, 'invalid_request'],
    [
      'a caller-supplied plugin key',
      'renderer:1',
      { pluginKey: 'orca-samples.other' },
      'invalid_request'
    ],
    ['a non-JSON message', 'renderer:1', { message: 10n }, 'invalid_request']
  ])('rejects panel messages from %s', async (_label, ownerKey, extra, code) => {
    const live = await createPlugin('orca-samples.live')
    const { panels, handle } = createSurfaces([live])
    const entry = await panels.open('renderer:1', live.pluginKey, 'live')
    await expect(
      panels.receiveFromPanel(ownerKey, { sessionToken: entry!.sessionToken, message: 1, ...extra })
    ).resolves.toMatchObject({ ok: false, code })
    expect(handle.deliverPanelMessage).not.toHaveBeenCalled()
  })

  it('requires the panelMessaging capability for panel → worker messages', async () => {
    const live = await createPlugin('orca-samples.live', [])
    const { panels, ensureWorker } = createSurfaces([live])
    const entry = await panels.open('renderer:1', live.pluginKey, 'live')
    await expect(
      panels.receiveFromPanel('renderer:1', { sessionToken: entry!.sessionToken, message: 1 })
    ).resolves.toMatchObject({ ok: false, code: 'capability_denied' })
    expect(ensureWorker).not.toHaveBeenCalled()
  })

  it('stops a revoked plugin from receiving or sending', async () => {
    const live = await createPlugin('orca-samples.live')
    const { panels, approved } = createSurfaces([live])
    const entry = await panels.open('renderer:1', live.pluginKey, 'live')
    const deliver = vi.fn()
    panels.attach('renderer:1', { sessionToken: entry!.sessionToken }, deliver)
    approved.delete(live.pluginKey)

    expect(panels.postToPanel(live.pluginKey, 'live', 1)).toMatchObject({ ok: false })
    await expect(
      panels.receiveFromPanel('renderer:1', { sessionToken: entry!.sessionToken, message: 1 })
    ).resolves.toMatchObject({ ok: false, code: 'unavailable' })
    expect(deliver).not.toHaveBeenCalled()
  })
})
