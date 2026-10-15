import { describe, expect, it, vi } from 'vitest'
import { createPluginWorkerRuntime, type PluginWorkerOrcaApi } from './plugin-host-runtime'

async function activate(register: (orca: PluginWorkerOrcaApi) => void) {
  const send = vi.fn()
  const runtime = createPluginWorkerRuntime({
    send,
    exit: vi.fn(),
    importModule: async () => ({ default: register })
  })
  await runtime.handleMessage({
    type: 'init',
    pluginId: 'orca-samples.tasks',
    pluginRoot: '/plugin',
    mainEntry: 'worker.js',
    grantedCapabilities: ['tasks:provide']
  })
  return { runtime, send }
}

describe('plugin worker task sources', () => {
  it('reports registered task sources when ready', async () => {
    const { send } = await activate((orca) => {
      orca.tasks.registerSource('roadmap', { list: () => ({ items: [] }), get: () => null })
    })

    expect(send).toHaveBeenCalledWith({ type: 'ready', commands: [], taskSources: ['roadmap'] })
  })

  it('routes each operation to its handler and returns the value', async () => {
    const list = vi.fn(async (params: unknown) => ({ items: [], echo: params }))
    const get = vi.fn(async () => ({ item: { id: 'a', title: 'A' } }))
    const { runtime, send } = await activate((orca) => {
      orca.tasks.registerSource('roadmap', { list, get })
    })

    await runtime.handleMessage({
      type: 'invokeTaskSource',
      callId: 7,
      sourceId: 'roadmap',
      operation: 'list',
      params: { query: 'x' }
    })
    await runtime.handleMessage({
      type: 'invokeTaskSource',
      callId: 8,
      sourceId: 'roadmap',
      operation: 'get',
      params: { itemId: 'a' }
    })

    expect(list).toHaveBeenCalledWith({ query: 'x' })
    expect(get).toHaveBeenCalledWith({ itemId: 'a' })
    expect(send).toHaveBeenCalledWith({
      type: 'taskSourceResult',
      callId: 7,
      ok: true,
      value: { items: [], echo: { query: 'x' } }
    })
    expect(send).toHaveBeenCalledWith({
      type: 'taskSourceResult',
      callId: 8,
      ok: true,
      value: { item: { id: 'a', title: 'A' } }
    })
  })

  it('answers with an error for an unregistered source or a throwing handler', async () => {
    const { runtime, send } = await activate((orca) => {
      orca.tasks.registerSource('roadmap', {
        list: () => {
          throw new Error('source unavailable')
        },
        get: () => null
      })
    })

    await runtime.handleMessage({
      type: 'invokeTaskSource',
      callId: 1,
      sourceId: 'other',
      operation: 'list',
      params: {}
    })
    await runtime.handleMessage({
      type: 'invokeTaskSource',
      callId: 2,
      sourceId: 'roadmap',
      operation: 'list',
      params: {}
    })

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'taskSourceResult', callId: 1, ok: false })
    )
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'taskSourceResult',
        callId: 2,
        ok: false,
        error: expect.stringContaining('source unavailable')
      })
    )
  })

  it('fails activation when a source lacks a handler', async () => {
    const exit = vi.fn()
    const send = vi.fn()
    const runtime = createPluginWorkerRuntime({
      send,
      exit,
      importModule: async () => ({
        // Plugins are plain JS, so model one whose view of the API lets it omit `get`.
        default: (orca: {
          tasks: { registerSource: (id: string, source: { list: () => null }) => void }
        }) => {
          orca.tasks.registerSource('roadmap', { list: () => null })
        }
      })
    })

    await runtime.handleMessage({
      type: 'init',
      pluginId: 'orca-samples.tasks',
      pluginRoot: '/plugin',
      mainEntry: 'worker.js',
      grantedCapabilities: []
    })

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'fatal', error: expect.stringContaining('list and get') })
    )
    expect(exit).toHaveBeenCalledWith(1)
  })
})
