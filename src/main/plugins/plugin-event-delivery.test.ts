import { describe, expect, it, vi } from 'vitest'
import { pluginManifestSchema } from '../../shared/plugins/plugin-manifest'
import { PluginEventBus } from './plugin-event-bus'
import { deliverPluginEvent } from './plugin-event-delivery'
import type { ValidDiscoveredPlugin } from './plugin-discovery'

function plugin(capabilities: { kind: string }[], events: { on: string }[]): ValidDiscoveredPlugin {
  const manifest = pluginManifestSchema.parse({
    manifestVersion: 1,
    id: 'demo',
    publisher: 'orca-samples',
    name: 'Demo',
    version: '1.0.0',
    engines: { orca: '>=1.0.0' },
    pluginApi: 1,
    main: 'worker.js',
    contributes: { events },
    capabilities
  })
  return {
    pluginKey: 'orca-samples.demo',
    rootDir: '/tmp/demo',
    manifest,
    consentFingerprint: 'sha256-test',
    contentHash: null,
    isDev: true
  }
}

describe('deliverPluginEvent ui.focus.changed', () => {
  it('does not deliver a dynamic subscription that lacks ui:focus', () => {
    const deliverEventIfRunning = vi.fn()
    const eventBus = new PluginEventBus()
    eventBus.subscribe('orca-samples.demo', ['ui.focus.changed'])
    deliverPluginEvent({
      event: 'ui.focus.changed',
      payload: { focusedSurface: { kind: 'terminal', title: 'zsh' }, receivedAt: Date.now() },
      plugins: [plugin([{ kind: 'events:subscribe' }], [])],
      eventBus,
      workerController: { ensure: vi.fn(), deliverEventIfRunning } as never,
      isRuntimeApproved: () => true,
      logWarning: vi.fn()
    })
    expect(deliverEventIfRunning).not.toHaveBeenCalled()
  })

  it('delivers to a consented ui:focus subscriber', () => {
    const deliverEvent = vi.fn()
    const ensure = vi.fn().mockResolvedValue({ deliverEvent })
    deliverPluginEvent({
      event: 'ui.focus.changed',
      payload: { focusedSurface: { kind: 'terminal', title: 'zsh' }, receivedAt: Date.now() },
      plugins: [
        plugin([{ kind: 'events:subscribe' }, { kind: 'ui:focus' }], [{ on: 'ui.focus.changed' }])
      ],
      eventBus: new PluginEventBus(),
      workerController: { ensure, deliverEventIfRunning: vi.fn() } as never,
      isRuntimeApproved: () => true,
      logWarning: vi.fn()
    })
    expect(ensure).toHaveBeenCalledOnce()
  })
})
