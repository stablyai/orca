import { describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createPluginWorkerRuntime, type PluginWorkerOrcaApi } from './plugin-host-runtime'

const init = (overrides: { pluginRoot?: string; mainEntry?: string } = {}) => ({
  orca: 1,
  kind: 'evt',
  event: 'init',
  payload: {
    pluginId: 'samples.demo',
    pluginRoot: '/plugin',
    mainEntry: 'worker.js',
    grantedCapabilities: [],
    ...overrides
  }
})

describe('plugin worker shutdown', () => {
  it('normalizes either manifest separator before importing the worker', async () => {
    const importModule = vi.fn(async () => ({ default: vi.fn() }))
    const runtime = createPluginWorkerRuntime({ send: vi.fn(), importModule })

    await runtime.handleMessage(
      init({ pluginRoot: join('plugin-root'), mainEntry: 'nested\\worker.js' })
    )

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
    await runtime.handleMessage(init())

    const shutdown = runtime.handleMessage({ orca: 1, kind: 'evt', event: 'shutdown' })
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
    await runtime.handleMessage(init())

    await runtime.handleMessage({ orca: 1, kind: 'evt', event: 'shutdown' })

    expect(exit).toHaveBeenCalledWith(0)
  })
})

describe('worker orca API parity with frames', () => {
  async function activateWith(activate: (orca: PluginWorkerOrcaApi) => void) {
    const send = vi.fn()
    const runtime = createPluginWorkerRuntime({
      send,
      exit: vi.fn(),
      importModule: async () => ({ default: activate })
    })
    await runtime.handleMessage(init())
    return { send, runtime }
  }

  it('exposes api and a synchronous has() for worker methods', async () => {
    let orca!: PluginWorkerOrcaApi
    await activateWith((api) => (orca = api))
    expect(orca.api).toEqual({ major: 1, minor: 0 })
    expect(orca.host.has('storage.get')).toBe(true)
    expect(orca.host.has('editor.applyEdit')).toBe(false)
    expect(Object.isFrozen(orca)).toBe(true)
  })

  it('maps host errors to code, retryable and retryAfterMs, unknown codes to action_failed', async () => {
    let orca!: PluginWorkerOrcaApi
    const { send, runtime } = await activateWith((api) => (orca = api))
    const limited = orca.host.call('storage.keys')
    const legacy = orca.host.call('storage.keys')
    const [first, second] = send.mock.calls
      .map(([message]) => message)
      .filter((message) => message.kind === 'req')
    await runtime.handleMessage({
      orca: 1,
      kind: 'res',
      id: first.id,
      error: { code: 'rate_limited', message: 'slow down', retryable: true, retryAfterMs: 500 }
    })
    await runtime.handleMessage({
      orca: 1,
      kind: 'res',
      id: second.id,
      error: { code: 'brand_new_code', message: 'newer host', retryable: false }
    })
    await expect(limited).rejects.toMatchObject({
      code: 'rate_limited',
      message: 'slow down',
      retryable: true,
      retryAfterMs: 500
    })
    await expect(legacy).rejects.toMatchObject({ code: 'action_failed', retryable: false })
  })

  it('cancels a host call when its signal aborts', async () => {
    let orca!: PluginWorkerOrcaApi
    const { send } = await activateWith((api) => (orca = api))
    const controller = new AbortController()
    const call = orca.host.call('storage.keys', {}, { signal: controller.signal })
    controller.abort()
    await expect(call).rejects.toMatchObject({ code: 'cancelled' })
    expect(send).toHaveBeenLastCalledWith({ orca: 1, kind: 'cancel', id: 0 })
  })

  it('hands command handlers a signal the host aborts, and disposes registrations', async () => {
    const seen: { signal?: AbortSignal } = {}
    let finish!: () => void
    const { send, runtime } = await activateWith((orca) => {
      orca.commands.register('run', (_args, context) => {
        seen.signal = context.signal
        return new Promise<void>((resolve) => (finish = resolve))
      })
      orca.events.on('workspace.created', vi.fn()).dispose()
    })
    expect(send).toHaveBeenLastCalledWith({
      orca: 1,
      kind: 'evt',
      event: 'ready',
      payload: { commands: ['run'] }
    })
    const running = runtime.handleMessage({
      orca: 1,
      kind: 'req',
      id: 9,
      method: 'command.invoke',
      params: { commandId: 'run' }
    })
    await runtime.handleMessage({ orca: 1, kind: 'cancel', id: 9 })
    expect(seen.signal?.aborted).toBe(true)
    finish()
    await running
    expect(send).toHaveBeenLastCalledWith({ orca: 1, kind: 'res', id: 9, result: undefined })
  })

  it('gives format 1 handlers worktreeId alongside workspaceId', async () => {
    const legacy = vi.fn()
    const current = vi.fn()
    const { runtime } = await activateWith((orca) => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: format 1 workers pass the old event name the runtime aliases.
      orca.events.on('worktree.created' as 'workspace.created', legacy)
      orca.events.on('workspace.created', current)
    })
    await runtime.handleMessage({
      orca: 1,
      kind: 'req',
      id: 3,
      method: 'event.deliver',
      params: { event: 'workspace.created', payload: { workspaceId: 'w1' } }
    })
    expect(legacy).toHaveBeenCalledWith({ workspaceId: 'w1', worktreeId: 'w1' })
    expect(current).toHaveBeenCalledWith({ workspaceId: 'w1' })
  })
})

describe('worker panel messages', () => {
  const panelMessage = (id: number, panelId: string, message: unknown) => ({
    orca: 1,
    kind: 'req',
    id,
    method: 'panel.message',
    params: { panelId, message }
  })

  async function activateWith(activate: (orca: PluginWorkerOrcaApi) => void) {
    const send = vi.fn()
    const runtime = createPluginWorkerRuntime({
      send,
      exit: vi.fn(),
      importModule: async () => ({ default: activate })
    })
    await runtime.handleMessage(init())
    return { send, runtime }
  }

  it('answers with the handler of that panel id, null for an undefined reply', async () => {
    const { send, runtime } = await activateWith((orca) => {
      orca.panels.onMessage('player', async (message) => ({ echoed: message }))
      orca.panels.onMessage('quiet', () => undefined)
    })
    await runtime.handleMessage(panelMessage(1, 'player', { type: 'getState' }))
    await runtime.handleMessage(panelMessage(2, 'quiet', 'x'))
    expect(send).toHaveBeenCalledWith({
      orca: 1,
      kind: 'res',
      id: 1,
      result: { echoed: { type: 'getState' } }
    })
    expect(send).toHaveBeenLastCalledWith({ orca: 1, kind: 'res', id: 2, result: null })
  })

  it('answers unknown_method at once when no handler is registered for the panel', async () => {
    const { send, runtime } = await activateWith((orca) => {
      orca.panels.onMessage('player', () => 'pong')
    })
    await runtime.handleMessage(panelMessage(1, 'settings', {}))
    expect(send).toHaveBeenLastCalledWith({
      orca: 1,
      kind: 'res',
      id: 1,
      error: {
        code: 'unknown_method',
        message: 'no message handler registered for panel settings',
        retryable: false
      }
    })
  })

  it('reports a thrown error as action_failed with its message and no stack', async () => {
    const { send, runtime } = await activateWith((orca) => {
      orca.panels.onMessage('player', () => {
        throw new Error('no active device')
      })
    })
    await runtime.handleMessage(panelMessage(1, 'player', {}))
    expect(send).toHaveBeenLastCalledWith({
      orca: 1,
      kind: 'res',
      id: 1,
      error: { code: 'action_failed', message: 'no active device', retryable: false }
    })
  })

  it('keeps one handler per panel id and frees the id on dispose', async () => {
    let orca!: PluginWorkerOrcaApi
    const { send, runtime } = await activateWith((api) => (orca = api))
    const first = orca.panels.onMessage('player', () => 'first')
    expect(() => orca.panels.onMessage('player', () => 'second')).toThrow('already registered')
    first.dispose()
    orca.panels.onMessage('player', () => 'second')
    // A stale subscription must not remove its successor's handler.
    first.dispose()
    await runtime.handleMessage(panelMessage(1, 'player', {}))
    expect(send).toHaveBeenLastCalledWith({ orca: 1, kind: 'res', id: 1, result: 'second' })
    expect(() => orca.panels.onMessage('', () => null)).toThrow(TypeError)
  })

  it('does not let a stale disposer remove a re-registration of the same function', async () => {
    let orca!: PluginWorkerOrcaApi
    const { send, runtime } = await activateWith((api) => (orca = api))
    const handler = () => 'again'
    const first = orca.panels.onMessage('player', handler)
    first.dispose()
    orca.panels.onMessage('player', handler)

    first.dispose()

    await runtime.handleMessage(panelMessage(1, 'player', {}))
    expect(send).toHaveBeenLastCalledWith({ orca: 1, kind: 'res', id: 1, result: 'again' })
  })

  it('refuses a message past 16 handlers still running, even ones that ignore their signal', async () => {
    const finishers: (() => void)[] = []
    const { send, runtime } = await activateWith((orca) => {
      orca.panels.onMessage('player', () => new Promise<void>((resolve) => finishers.push(resolve)))
    })
    const running = Array.from({ length: 16 }, (_, i) =>
      runtime.handleMessage(panelMessage(i + 1, 'player', {}))
    )
    // The host gave up on message 1 at its timeout; the handler is still running.
    await runtime.handleMessage({ orca: 1, kind: 'cancel', id: 1 })

    await runtime.handleMessage(panelMessage(100, 'player', {}))
    expect(send).toHaveBeenLastCalledWith({
      orca: 1,
      kind: 'res',
      id: 100,
      error: {
        code: 'rate_limited',
        message: 'too many panel message handlers are running',
        retryable: true
      }
    })

    finishers[0]()
    await running[0]
    const next = runtime.handleMessage(panelMessage(101, 'player', {}))
    expect(finishers).toHaveLength(17)
    finishers.forEach((finish) => finish())
    await Promise.all([...running, next])
  })

  it('hands the handler a signal the host aborts', async () => {
    const seen: { signal?: AbortSignal } = {}
    let finish!: () => void
    const { runtime } = await activateWith((orca) => {
      orca.panels.onMessage('player', (_message, context) => {
        seen.signal = context.signal
        return new Promise<void>((resolve) => (finish = resolve))
      })
    })
    const running = runtime.handleMessage(panelMessage(9, 'player', {}))
    await runtime.handleMessage({ orca: 1, kind: 'cancel', id: 9 })
    expect(seen.signal?.aborted).toBe(true)
    finish()
    await running
  })
})
