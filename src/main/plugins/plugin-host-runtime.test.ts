import { describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createPluginWorkerRuntime, type PluginWorkerOrcaApi } from './plugin-host-runtime'
import type { PluginWorkerChildMessage } from '../../shared/plugins/plugin-host-protocol'

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

describe('task source registration', () => {
  it('reports registered sources on ready and answers an invocation', async () => {
    const sent: PluginWorkerChildMessage[] = []
    const runtime = createPluginWorkerRuntime({
      send: (message) => sent.push(message),
      importModule: async () => ({
        default: (orca: PluginWorkerOrcaApi) => {
          orca.taskSources.register('azure-boards', {
            listItems: () => ({ ok: true, data: { items: [], nextCursor: null } })
          })
        }
      })
    })

    await runtime.handleMessage({
      type: 'init',
      pluginId: 'acme.boards',
      pluginRoot: '/plugins/boards',
      mainEntry: 'main.mjs',
      grantedCapabilities: []
    })

    expect(sent.find((message) => message.type === 'ready')).toMatchObject({
      taskSources: ['azure-boards']
    })

    await runtime.handleMessage({
      type: 'invokeTaskSource',
      callId: 7,
      sourceId: 'azure-boards',
      method: 'listItems',
      params: { scopeIds: [], search: null, cursor: null, limit: 50 }
    })

    expect(sent.find((message) => message.type === 'taskSourceResult')).toMatchObject({
      callId: 7,
      ok: true,
      value: { ok: true, data: { items: [], nextCursor: null } }
    })
  })

  it('fails an unregistered method rather than hanging the caller', async () => {
    const sent: PluginWorkerChildMessage[] = []
    const runtime = createPluginWorkerRuntime({
      send: (message) => sent.push(message),
      importModule: async () => ({
        default: (orca: PluginWorkerOrcaApi) => {
          orca.taskSources.register('azure-boards', {})
        }
      })
    })

    await runtime.handleMessage({
      type: 'init',
      pluginId: 'acme.boards',
      pluginRoot: '/plugins/boards',
      mainEntry: 'main.mjs',
      grantedCapabilities: []
    })
    await runtime.handleMessage({
      type: 'invokeTaskSource',
      callId: 1,
      sourceId: 'azure-boards',
      method: 'applyPatch'
    })

    const result = sent.find((message) => message.type === 'taskSourceResult')
    expect(result).toMatchObject({ callId: 1, ok: false })
  })
})
