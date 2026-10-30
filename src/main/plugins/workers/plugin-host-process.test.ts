import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const processMocks = vi.hoisted(() => ({ fork: vi.fn() }))
vi.mock('node:child_process', () => ({ fork: processMocks.fork }))

import { startPluginWorker } from './plugin-host-process'

class FakeChild extends EventEmitter {
  connected = true
  stdout = new PassThrough()
  stderr = new PassThrough()
  send = vi.fn()
  kill = vi.fn()
}

function start(
  child: FakeChild,
  options: { eventTimeoutMs?: number; invokeTimeoutMs?: number } = {}
) {
  processMocks.fork.mockReturnValue(child)
  return startPluginWorker({
    pluginId: 'samples.demo',
    rootDir: '/plugin',
    mainEntry: 'worker.js',
    entryPath: '/host.js',
    grantedCapabilities: [],
    executeHostCall: async () => ({ ok: true, value: null }),
    log: vi.fn(),
    ...options
  })
}

const ready = (commands: string[]) => ({
  orca: 1,
  kind: 'evt',
  event: 'ready',
  payload: { commands }
})

beforeEach(() => {
  processMocks.fork.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('startPluginWorker', () => {
  it('does not inherit Orca execArgv', async () => {
    const child = new FakeChild()
    const pending = start(child)
    child.emit('message', ready([]))
    await pending

    expect(processMocks.fork).toHaveBeenCalledWith(
      '/host.js',
      [],
      expect.objectContaining({ execArgv: [] })
    )
  })

  it('replays an exit that happened before handle registration', async () => {
    const child = new FakeChild()
    const pending = start(child)
    child.emit('message', ready(['run']))
    const handle = await pending
    child.emit('exit', 23)
    const onExit = vi.fn()

    handle.onExit(onExit)

    expect(onExit).toHaveBeenCalledOnce()
    expect(onExit).toHaveBeenCalledWith(23)
  })

  it('kills a live worker that disconnects its IPC channel', async () => {
    const child = new FakeChild()
    const pending = start(child)
    child.emit('message', ready(['run']))
    const handle = await pending
    const command = handle.invokeCommand('run')
    child.connected = false

    child.emit('disconnect')

    await expect(command).rejects.toThrow('disconnected')
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('counts delivered events as in flight until their acknowledgement', async () => {
    const child = new FakeChild()
    const pending = start(child)
    child.emit('message', ready([]))
    const handle = await pending

    handle.deliverEvent('workspace.created', {
      workspaceId: 'worktree-1',
      kind: 'worktree',
      path: '/repo',
      branch: 'feature'
    })

    expect(handle.inFlightCount()).toBe(1)
    child.emit('message', { orca: 1, kind: 'res', id: 0, result: null })
    expect(handle.inFlightCount()).toBe(0)
  })

  it('kills a worker whose event handler never acknowledges completion', async () => {
    vi.useFakeTimers()
    const child = new FakeChild()
    const pending = start(child, { eventTimeoutMs: 25 })
    child.emit('message', ready([]))
    const handle = await pending

    handle.deliverEvent('workspace.created', {
      workspaceId: 'worktree-1',
      kind: 'worktree',
      path: '/repo',
      branch: 'feature'
    })
    await vi.advanceTimersByTimeAsync(25)

    expect(handle.inFlightCount()).toBe(0)
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('kills a worker that exceeds the pending event cap', async () => {
    const child = new FakeChild()
    const pending = start(child)
    child.emit('message', ready([]))
    const handle = await pending

    for (let index = 0; index < 65; index += 1) {
      handle.deliverEvent('agent.status.changed', {
        workspaceId: null,
        paneKey: `pane-${index}`,
        state: 'working',
        receivedAt: Date.now()
      })
    }

    expect(handle.inFlightCount()).toBe(64)
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('relays worker host calls on the envelope, and drops the answer to a cancelled one', async () => {
    const child = new FakeChild()
    let finish!: (outcome: { ok: true; value: unknown }) => void
    const executeHostCall = vi.fn(
      () => new Promise<{ ok: true; value: unknown }>((resolve) => (finish = resolve))
    )
    processMocks.fork.mockReturnValue(child)
    const pending = startPluginWorker({
      pluginId: 'samples.demo',
      rootDir: '/plugin',
      mainEntry: 'worker.js',
      entryPath: '/host.js',
      grantedCapabilities: [],
      executeHostCall,
      log: vi.fn()
    })
    child.emit('message', ready([]))
    await pending

    child.emit('message', { orca: 1, kind: 'req', id: 3, method: 'storage.keys', params: {} })
    expect(executeHostCall).toHaveBeenCalledWith('storage.keys', {})
    finish({ ok: true, value: { keys: [] } })
    await vi.waitFor(() =>
      expect(child.send).toHaveBeenLastCalledWith({
        orca: 1,
        kind: 'res',
        id: 3,
        result: { keys: [] }
      })
    )

    child.emit('message', { orca: 1, kind: 'req', id: 4, method: 'storage.keys', params: {} })
    child.emit('message', { orca: 1, kind: 'cancel', id: 4 })
    const sends = child.send.mock.calls.length
    finish({ ok: true, value: { keys: [] } })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(child.send.mock.calls.length).toBe(sends)
  })

  it('cancels a command in the worker when it times out', async () => {
    vi.useFakeTimers()
    const child = new FakeChild()
    processMocks.fork.mockReturnValue(child)
    const pending = startPluginWorker({
      pluginId: 'samples.demo',
      rootDir: '/plugin',
      mainEntry: 'worker.js',
      entryPath: '/host.js',
      grantedCapabilities: [],
      executeHostCall: async () => ({ ok: true, value: null }),
      log: vi.fn(),
      invokeTimeoutMs: 25
    })
    child.emit('message', ready(['run']))
    const handle = await pending
    const command = handle.invokeCommand('run')
    const rejected = expect(command).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(25)
    await rejected
    expect(child.send).toHaveBeenLastCalledWith({ orca: 1, kind: 'cancel', id: 0 })
  })

  describe('deliverPanelMessage', () => {
    async function startReady(options: { invokeTimeoutMs?: number } = {}) {
      const child = new FakeChild()
      const pending = start(child, options)
      child.emit('message', ready([]))
      return { child, handle: await pending }
    }

    it('sends the panel id and message and resolves with the worker reply', async () => {
      const { child, handle } = await startReady()
      const reply = handle.deliverPanelMessage('player', { type: 'getState' })
      expect(child.send).toHaveBeenLastCalledWith({
        orca: 1,
        kind: 'req',
        id: 0,
        method: 'panel.message',
        params: { panelId: 'player', message: { type: 'getState' } }
      })
      expect(handle.inFlightCount()).toBe(1)
      child.emit('message', { orca: 1, kind: 'res', id: 0, result: { playing: true } })
      await expect(reply).resolves.toEqual({ ok: true, value: { playing: true } })
      expect(handle.inFlightCount()).toBe(0)
    })

    it('keeps the code of a worker failure and turns a missing result into null', async () => {
      const { child, handle } = await startReady()
      const missing = handle.deliverPanelMessage('settings', {})
      const failed = handle.deliverPanelMessage('player', {})
      const quiet = handle.deliverPanelMessage('player', {})
      child.emit('message', {
        orca: 1,
        kind: 'res',
        id: 0,
        error: { code: 'unknown_method', message: 'no handler', retryable: false }
      })
      child.emit('message', {
        orca: 1,
        kind: 'res',
        id: 1,
        error: { code: 'from_the_future', message: 'boom', retryable: false }
      })
      child.emit('message', { orca: 1, kind: 'res', id: 2 })
      await expect(missing).resolves.toEqual({
        ok: false,
        code: 'unknown_method',
        error: 'no handler'
      })
      await expect(failed).resolves.toEqual({ ok: false, code: 'action_failed', error: 'boom' })
      await expect(quiet).resolves.toEqual({ ok: true, value: null })
    })

    it('answers unavailable to messages in flight when the worker exits, and to later ones', async () => {
      const { child, handle } = await startReady()
      const reply = handle.deliverPanelMessage('player', {})
      child.emit('exit', 1)
      await expect(reply).resolves.toMatchObject({ ok: false, code: 'unavailable' })
      await expect(handle.deliverPanelMessage('player', {})).resolves.toMatchObject({
        ok: false,
        code: 'unavailable'
      })
      expect(handle.inFlightCount()).toBe(0)
    })

    it('times out a handler that never answers and cancels it in the worker', async () => {
      vi.useFakeTimers()
      const { child, handle } = await startReady({ invokeTimeoutMs: 25 })
      const reply = handle.deliverPanelMessage('player', {})
      await vi.advanceTimersByTimeAsync(25)
      await expect(reply).resolves.toMatchObject({ ok: false, code: 'timeout' })
      expect(child.send).toHaveBeenLastCalledWith({ orca: 1, kind: 'cancel', id: 0 })
      expect(handle.inFlightCount()).toBe(0)
    })

    it('refuses messages past the pending cap without killing the worker', async () => {
      const { child, handle } = await startReady()
      const waiting = Array.from({ length: 16 }, () => handle.deliverPanelMessage('player', {}))
      await expect(handle.deliverPanelMessage('player', {})).resolves.toMatchObject({
        ok: false,
        code: 'rate_limited'
      })
      expect(child.kill).not.toHaveBeenCalled()
      child.emit('message', { orca: 1, kind: 'res', id: 0, result: 'done' })
      await expect(waiting[0]).resolves.toEqual({ ok: true, value: 'done' })
      handle.deliverPanelMessage('player', {})
      expect(handle.inFlightCount()).toBe(16)
    })
  })
})
