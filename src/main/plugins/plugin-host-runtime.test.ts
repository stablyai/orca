import { describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createPluginWorkerRuntime, type PluginWorkerOrcaApi } from './plugin-host-runtime'

describe('plugin worker shutdown', () => {
  it('normalizes either manifest separator before importing the worker', async () => {
    const importModule = vi.fn(async () => ({ default: vi.fn() }))
    const runtime = createPluginWorkerRuntime({ send: vi.fn(), importModule })

    await runtime.handleMessage({
      type: 'init',
      pluginId: 'orca-samples.demo',
      pluginRoot: join('plugin-root'),
      mainEntry: 'nested\\worker.js',
      grantedCapabilities: []
    })

    expect(importModule).toHaveBeenCalledWith(
      pathToFileURL(join('plugin-root', 'nested', 'worker.js')).href
    )
  })

  it('awaits an optional deactivate export before exiting', async () => {
    let finishDeactivate!: () => void
    const deactivate = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishDeactivate = resolve
        })
    )
    const send = vi.fn()
    const exit = vi.fn()
    const runtime = createPluginWorkerRuntime({
      send,
      exit,
      importModule: async () => ({ default: vi.fn(), deactivate })
    })
    await runtime.handleMessage({
      type: 'init',
      pluginId: 'orca-samples.demo',
      pluginRoot: '/plugin',
      mainEntry: 'worker.js',
      grantedCapabilities: []
    })

    const shutdown = runtime.handleMessage({ type: 'shutdown' })
    await Promise.resolve()
    expect(deactivate).toHaveBeenCalledOnce()
    expect(exit).not.toHaveBeenCalled()
    finishDeactivate()
    await shutdown

    expect(exit).toHaveBeenCalledWith(0)
  })

  it('exits immediately when the plugin has no deactivate export', async () => {
    const exit = vi.fn()
    const runtime = createPluginWorkerRuntime({
      send: vi.fn(),
      exit,
      importModule: async () => ({ default: vi.fn() })
    })
    await runtime.handleMessage({
      type: 'init',
      pluginId: 'orca-samples.demo',
      pluginRoot: '/plugin',
      mainEntry: 'worker.js',
      grantedCapabilities: []
    })

    await runtime.handleMessage({ type: 'shutdown' })

    expect(exit).toHaveBeenCalledWith(0)
  })
})

describe('plugin worker status bar and panel SDK', () => {
  async function activateWith(activate: (orca: PluginWorkerOrcaApi) => void) {
    const send = vi.fn()
    const runtime = createPluginWorkerRuntime({
      send,
      importModule: async () => ({ default: activate })
    })
    await runtime.handleMessage({
      type: 'init',
      pluginId: 'orca-samples.demo',
      pluginRoot: '/plugin',
      mainEntry: 'worker.js',
      grantedCapabilities: ['statusBar', 'panelMessaging']
    })
    return { runtime, send }
  }

  it('maps statusBar.update and panels.postMessage onto capability-gated host calls', async () => {
    const captured: { orca?: PluginWorkerOrcaApi } = {}
    const { runtime, send } = await activateWith((orca) => {
      captured.orca = orca
    })
    const update = captured.orca!.statusBar.update('pulse', {
      text: 'Pulse 1',
      severity: 'warning'
    })
    const post = captured.orca!.panels.postMessage('live', { tick: 1 })

    expect(send).toHaveBeenCalledWith({
      type: 'hostCall',
      callId: 0,
      method: 'statusBar.update',
      params: { text: 'Pulse 1', severity: 'warning', itemId: 'pulse' }
    })
    expect(send).toHaveBeenCalledWith({
      type: 'hostCall',
      callId: 1,
      method: 'panels.postMessage',
      params: { panelId: 'live', message: { tick: 1 } }
    })
    await runtime.handleMessage({ type: 'hostResult', callId: 0, ok: true, value: { ok: true } })
    await runtime.handleMessage({
      type: 'hostResult',
      callId: 1,
      ok: false,
      errorCode: 'capability_denied',
      error: 'denied'
    })
    await expect(update).resolves.toEqual({ ok: true })
    await expect(post).rejects.toMatchObject({ code: 'capability_denied' })
  })

  it("dispatches panel messages to that panel's handlers until unsubscribed", async () => {
    const live = vi.fn()
    const other = vi.fn()
    const captured: { unsubscribe?: () => void } = {}
    const { runtime, send } = await activateWith((orca) => {
      captured.unsubscribe = orca.panels.onMessage('live', live)
      orca.panels.onMessage('other', other)
      orca.panels.onMessage('live', () => {
        throw new Error('handler failed')
      })
    })

    await runtime.handleMessage({ type: 'deliverPanelMessage', panelId: 'live', message: { a: 1 } })
    captured.unsubscribe!()
    await runtime.handleMessage({ type: 'deliverPanelMessage', panelId: 'live', message: { a: 2 } })

    expect(live).toHaveBeenCalledTimes(1)
    expect(live).toHaveBeenCalledWith({ a: 1 })
    expect(other).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'log',
        level: 'error',
        message: expect.stringContaining('handler failed')
      })
    )
  })
})
