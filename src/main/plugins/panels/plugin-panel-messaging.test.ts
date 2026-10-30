import { describe, expect, it, vi } from 'vitest'
import { pluginManifestSchema } from '../../../shared/plugins/manifest/plugin-manifest'
import { PLUGIN_PANEL_MESSAGING_SINCE } from '../../../shared/plugins/manifest/plugin-schema-field-docs'
import type { ValidDiscoveredPlugin } from '../plugin-discovery'
import {
  createPluginPanelMessaging,
  type PluginPanelMessagingOptions
} from './plugin-panel-messaging'

function plugin(
  events: { on: 'panel.action' }[] = [{ on: 'panel.action' }]
): ValidDiscoveredPlugin {
  return {
    pluginKey: 'samples.board',
    rootDir: '/plugins/board',
    manifest: pluginManifestSchema.parse({
      manifestVersion: 2,
      execution: 'trusted-worker',
      id: 'board',
      publisher: 'samples',
      name: 'Board',
      version: '1.0.0',
      engines: { orca: `>=${PLUGIN_PANEL_MESSAGING_SINCE}` },
      pluginApi: 1,
      main: 'main.mjs',
      contributes: { panels: [{ id: 'board', title: 'Board', entry: 'panel.html' }], events },
      capabilities: [{ kind: 'panel:own' }]
    }),
    consentFingerprint: 'sha256-consented',
    contentHash: null,
    isDev: true
  }
}

function messaging(overrides: Partial<PluginPanelMessagingOptions> = {}) {
  const sink = vi.fn().mockReturnValue(true)
  const deliverToWorker = vi.fn().mockResolvedValue(undefined)
  const api = createPluginPanelMessaging({
    resolveApprovedPlugin: (key) => (key === 'samples.board' ? plugin() : null),
    grantedCapabilities: () => ['panel:own'],
    hasOpenFrame: () => true,
    sink: () => sink,
    deliverToWorker,
    ...overrides
  })
  return { api, sink, deliverToWorker }
}

describe('panel.post', () => {
  it('hands the message to the sink when the panel has an open frame', async () => {
    const { api, sink } = messaging()
    await expect(api.post('samples.board', 'board', { n: 1 })).resolves.toEqual({
      delivered: true
    })
    expect(sink).toHaveBeenCalledWith({
      pluginKey: 'samples.board',
      panelId: 'board',
      payload: { n: 1 }
    })
  })

  it('reports not delivered without calling the sink when no frame is open', async () => {
    const { api, sink } = messaging({ hasOpenFrame: () => false })
    await expect(api.post('samples.board', 'board', 1)).resolves.toEqual({ delivered: false })
    expect(sink).not.toHaveBeenCalled()
  })

  it('reports not delivered when no sink is bound', async () => {
    const { api } = messaging({ sink: () => null })
    await expect(api.post('samples.board', 'board', 1)).resolves.toEqual({ delivered: false })
  })

  it('refuses a panel the manifest does not list and a plugin that is not enabled', async () => {
    const { api } = messaging()
    await expect(api.post('samples.board', 'nope', 1)).rejects.toThrow('no panel nope')
    await expect(api.post('samples.other', 'board', 1)).rejects.toThrow('not enabled')
  })
})

describe('panel.action', () => {
  it('delivers a panel.action event to the worker with the panel id, action and params', async () => {
    const { api, deliverToWorker } = messaging()
    await api.action('samples.board', 'board', 'next', { index: 2 })
    expect(deliverToWorker).toHaveBeenCalledWith(
      expect.objectContaining({ pluginKey: 'samples.board' }),
      'panel.action',
      { panelId: 'board', action: 'next', params: { index: 2 } }
    )
  })

  it('omits params when the panel sent none', async () => {
    const { api, deliverToWorker } = messaging()
    await api.action('samples.board', 'board', 'seen', undefined)
    expect(deliverToWorker.mock.calls[0]![2]).toStrictEqual({ panelId: 'board', action: 'seen' })
  })

  it('refuses when the plugin does not subscribe to panel.action or lacks the grant', async () => {
    const unsubscribed = messaging({ resolveApprovedPlugin: () => plugin([]) })
    await expect(unsubscribed.api.action('samples.board', 'board', 'x', undefined)).rejects.toThrow(
      'does not subscribe'
    )
    const ungranted = messaging({ grantedCapabilities: () => [] })
    await expect(ungranted.api.action('samples.board', 'board', 'x', undefined)).rejects.toThrow(
      'panel:own'
    )
    expect(ungranted.deliverToWorker).not.toHaveBeenCalled()
  })
})
