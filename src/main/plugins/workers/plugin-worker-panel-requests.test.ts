import { describe, expect, it, vi } from 'vitest'
import { createPluginWorkerRuntime, type PluginWorkerOrcaApi } from './plugin-host-runtime'

const panel = { id: 'panel-1', surface: 'panel', contributionId: 'todos' }

async function activate(setup: (orca: PluginWorkerOrcaApi) => void) {
  const send = vi.fn()
  const runtime = createPluginWorkerRuntime({
    send,
    exit: vi.fn(),
    importModule: async () => ({ default: setup })
  })
  await runtime.handleMessage({
    orca: 1,
    kind: 'evt',
    event: 'init',
    payload: {
      pluginId: 'samples.demo',
      pluginRoot: '/p',
      mainEntry: 'm.js',
      grantedCapabilities: []
    }
  })
  send.mockClear()
  const request = (id: number, name: string, input: unknown) =>
    runtime.handleMessage({
      orca: 1,
      kind: 'req',
      id,
      method: 'panel.request',
      params: { name, input, panel }
    })
  return { send, runtime, request }
}

describe('worker panel requests', () => {
  it('answers with the handler result and hands it the calling panel', async () => {
    const handler = vi.fn(async (input: unknown) => ({ echoed: input }))
    const { send, request } = await activate((orca) => orca.panels.handle('todos.list', handler))
    await request(4, 'todos.list', { done: true })
    expect(handler).toHaveBeenCalledWith({ done: true }, { panel, signal: expect.any(AbortSignal) })
    expect(send).toHaveBeenCalledWith({
      orca: 1,
      kind: 'res',
      id: 4,
      result: { echoed: { done: true } }
    })
  })

  it('keeps a known error code the handler threw, and refuses unknown names', async () => {
    const { send, request } = await activate((orca) => {
      orca.panels.handle('todos.add', () => {
        throw Object.assign(new Error('title is taken'), { code: 'conflict' })
      })
      orca.panels.handle('todos.bad', () => {
        throw Object.assign(new Error('nope'), { code: 'made_up' })
      })
    })
    await request(1, 'todos.add', {})
    await request(2, 'todos.bad', {})
    await request(3, 'todos.missing', {})
    const errors = send.mock.calls.map(([message]) => message.error?.code)
    expect(errors).toEqual(['conflict', 'action_failed', 'unknown_method'])
  })

  it('aborts the handler signal when the host cancels the request', async () => {
    let seen: AbortSignal | undefined
    let release!: () => void
    const { runtime, request } = await activate((orca) =>
      orca.panels.handle('slow', (_input, { signal }) => {
        seen = signal
        return new Promise<null>((resolve) => (release = () => resolve(null)))
      })
    )
    const pending = request(9, 'slow', null)
    await vi.waitFor(() => expect(seen).toBeDefined())
    await runtime.handleMessage({ orca: 1, kind: 'cancel', id: 9 })
    expect(seen?.aborted).toBe(true)
    release()
    await pending
  })

  it('posts to panels, and validates names on both sides', async () => {
    let orca!: PluginWorkerOrcaApi
    const { send } = await activate((api) => (orca = api))
    orca.panels.post('todos.changed', { count: 2 }, { panel: 'panel-1' })
    expect(send).toHaveBeenCalledWith({
      orca: 1,
      kind: 'evt',
      event: 'panel.post',
      payload: { event: 'todos.changed', payload: { count: 2 }, panel: 'panel-1' }
    })
    expect(() => orca.panels.post('has spaces')).toThrow()
    expect(() => orca.panels.handle('', () => null)).toThrow()
  })

  it('tells storage and settings listeners which key changed', async () => {
    const storage = vi.fn()
    const settings = vi.fn()
    const { runtime } = await activate((orca) => {
      orca.storage.onDidChange(storage)
      orca.settings.onDidChange(settings)
    })
    await runtime.handleMessage({
      orca: 1,
      kind: 'evt',
      event: 'data.changed',
      payload: { area: 'settings', key: 'apiUrl' }
    })
    expect(settings).toHaveBeenCalledWith({ key: 'apiUrl' })
    expect(storage).not.toHaveBeenCalled()
  })

  it('reads storage and settings through host calls', async () => {
    let orca!: PluginWorkerOrcaApi
    const { send, runtime } = await activate((api) => (orca = api))
    const value = orca.storage.get('todos')
    const setting = orca.settings.get('apiUrl')
    const [get, settingsGet] = send.mock.calls.map(([message]) => message)
    expect(get).toMatchObject({ method: 'storage.get', params: { key: 'todos' } })
    expect(settingsGet).toMatchObject({ method: 'settings.get' })
    await runtime.handleMessage({ orca: 1, kind: 'res', id: get.id, result: { value: [1] } })
    await runtime.handleMessage({
      orca: 1,
      kind: 'res',
      id: settingsGet.id,
      result: { settings: { apiUrl: 'https://x' } }
    })
    await expect(value).resolves.toEqual([1])
    await expect(setting).resolves.toBe('https://x')
  })
})

describe('worker entry', () => {
  it('names the fix when activate is exported by name instead of as the default', async () => {
    const activate = vi.fn()
    const send = vi.fn()
    const runtime = createPluginWorkerRuntime({
      send,
      exit: vi.fn(),
      importModule: async () => ({ activate })
    })
    await runtime.handleMessage({
      orca: 1,
      kind: 'evt',
      event: 'init',
      payload: {
        pluginId: 'samples.demo',
        pluginRoot: '/p',
        mainEntry: 'm.js',
        grantedCapabilities: []
      }
    })
    expect(activate).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'fatal',
        payload: { error: expect.stringContaining('export default function activate(orca)') }
      })
    )
  })
})

describe('workspace.changed in workers', () => {
  it('replays the current context to a handler as it subscribes', async () => {
    let orca!: PluginWorkerOrcaApi
    const { send, runtime } = await activate((api) => (orca = api))
    const handler = vi.fn()
    const disposed = vi.fn()
    orca.events.on('workspace.changed', handler)
    orca.events.on('workspace.changed', disposed).dispose()
    const reads = send.mock.calls
      .map(([message]) => message)
      .filter((message) => message.method === 'workspace.readContext')
    expect(reads).toHaveLength(2)
    for (const read of reads) {
      await runtime.handleMessage({ orca: 1, kind: 'res', id: read.id, result: { branch: 'main' } })
    }
    await vi.waitFor(() => expect(handler).toHaveBeenCalledWith({ context: { branch: 'main' } }))
    expect(disposed).not.toHaveBeenCalled()
  })
})
