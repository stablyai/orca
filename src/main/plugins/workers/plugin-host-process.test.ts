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

function start(child: FakeChild, options: { eventTimeoutMs?: number } = {}) {
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
})
