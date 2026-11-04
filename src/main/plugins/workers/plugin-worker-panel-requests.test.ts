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
})
