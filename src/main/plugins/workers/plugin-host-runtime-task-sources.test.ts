import { describe, expect, it, vi } from 'vitest'
import { createPluginWorkerRuntime, type PluginWorkerOrcaApi } from './plugin-host-runtime'

const init = (grantedCapabilities: string[]) => ({
  orca: 1,
  kind: 'evt',
  event: 'init',
  payload: {
    pluginId: 'orca-samples.tasks',
    pluginRoot: '/plugin',
    mainEntry: 'worker.js',
    grantedCapabilities
  }
})

const invoke = (id: number, sourceId: string, operation: 'list' | 'get', params: unknown) => ({
  orca: 1,
  kind: 'req',
  id,
  method: 'taskSource.invoke',
  params: { sourceId, operation, params }
})

async function activate(register: (orca: PluginWorkerOrcaApi) => void) {
  const send = vi.fn()
  const runtime = createPluginWorkerRuntime({
    send,
    exit: vi.fn(),
    importModule: async () => ({ default: register })
  })
  await runtime.handleMessage(init(['tasks:provide']))
  return { runtime, send }
}

describe('plugin worker task sources', () => {
  it('reports registered task sources when ready', async () => {
    const { send } = await activate((orca) => {
      orca.tasks.registerSource('roadmap', { list: () => ({ items: [] }), get: () => null })
    })

    expect(send).toHaveBeenCalledWith({
      orca: 1,
      kind: 'evt',
      event: 'ready',
      payload: { commands: [], taskSources: ['roadmap'] }
    })
  })

  it('routes each operation to its handler and returns the value', async () => {
    const list = vi.fn(async (params: unknown) => ({ items: [], echo: params }))
    const get = vi.fn(async () => ({ item: { id: 'a', title: 'A' } }))
    const { runtime, send } = await activate((orca) => {
      orca.tasks.registerSource('roadmap', { list, get })
    })

    await runtime.handleMessage(invoke(7, 'roadmap', 'list', { query: 'x' }))
    await runtime.handleMessage(invoke(8, 'roadmap', 'get', { itemId: 'a' }))

    expect(list).toHaveBeenCalledWith({ query: 'x' }, { signal: expect.any(AbortSignal) })
    expect(get).toHaveBeenCalledWith({ itemId: 'a' }, { signal: expect.any(AbortSignal) })
    expect(send).toHaveBeenCalledWith({
      orca: 1,
      kind: 'res',
      id: 7,
      result: { items: [], echo: { query: 'x' } }
    })
    expect(send).toHaveBeenCalledWith({
      orca: 1,
      kind: 'res',
      id: 8,
      result: { item: { id: 'a', title: 'A' } }
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

    await runtime.handleMessage(invoke(1, 'other', 'list', {}))
    await runtime.handleMessage(invoke(2, 'roadmap', 'list', {}))

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'res',
        id: 1,
        error: expect.objectContaining({ code: 'unknown_method' })
      })
    )
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'res',
        id: 2,
        error: expect.objectContaining({ message: expect.stringContaining('source unavailable') })
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

    await runtime.handleMessage(init([]))

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'fatal',
        payload: { error: expect.stringContaining('list and get') }
      })
    )
    expect(exit).toHaveBeenCalledWith(1)
  })
})
