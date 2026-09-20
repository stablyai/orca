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
    pluginId: 'orca-samples.demo',
    rootDir: '/plugin',
    mainEntry: 'worker.js',
    entryPath: '/host.js',
    grantedCapabilities: [],
    executeHostCall: async () => ({ ok: true, value: null }),
    log: vi.fn(),
    ...options
  })
}

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
    child.emit('message', { type: 'ready', commands: [] })
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
    child.emit('message', { type: 'ready', commands: ['run'] })
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
    child.emit('message', { type: 'ready', commands: ['run'] })
    const handle = await pending
    const command = handle.invokeCommand('run')
    child.connected = false

    child.emit('disconnect')

    await expect(command).rejects.toThrow('disconnected')
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('exposes the task sources the worker announced when it became ready', async () => {
    const child = new FakeChild()
    const pending = start(child)
    child.emit('message', { type: 'ready', commands: [], taskSources: ['boards', 'issues'] })

    const handle = await pending

    expect(handle.taskSources).toEqual(['boards', 'issues'])
  })

  it('reports no task sources for a worker that announced none', async () => {
    const child = new FakeChild()
    const pending = start(child)
    child.emit('message', { type: 'ready', commands: ['run'] })

    const handle = await pending

    expect(handle.taskSources).toEqual([])
  })

  it('routes a task source call to the worker and resolves with its result', async () => {
    const child = new FakeChild()
    const pending = start(child)
    child.emit('message', { type: 'ready', commands: [], taskSources: ['boards'] })
    const handle = await pending

    const call = handle.invokeTaskSource('boards', 'listItems', { limit: 2 })

    expect(child.send).toHaveBeenLastCalledWith({
      type: 'invokeTaskSource',
      callId: 0,
      sourceId: 'boards',
      method: 'listItems',
      params: { limit: 2 }
    })
    expect(handle.inFlightCount()).toBe(1)
    child.emit('message', {
      type: 'taskSourceResult',
      callId: 0,
      ok: true,
      value: { ok: true, data: { items: [], nextCursor: null } }
    })
    await expect(call).resolves.toEqual({ ok: true, data: { items: [], nextCursor: null } })
    expect(handle.inFlightCount()).toBe(0)
  })

  it('answers each concurrent task source call from the source it addressed', async () => {
    const child = new FakeChild()
    const pending = start(child)
    child.emit('message', { type: 'ready', commands: [], taskSources: ['boards', 'issues'] })
    const handle = await pending

    const boards = handle.invokeTaskSource('boards', 'status')
    const issues = handle.invokeTaskSource('issues', 'status')

    const sent = child.send.mock.calls
      .map(([message]) => message)
      .filter((message) => message.type === 'invokeTaskSource')
    expect(sent.map((message) => message.sourceId)).toEqual(['boards', 'issues'])
    // The worker answers out of order, so only the sourceId that went out with
    // each call can decide which promise gets which answer.
    child.emit('message', {
      type: 'taskSourceResult',
      callId: sent[1].callId,
      ok: true,
      value: 'issue-status'
    })
    child.emit('message', {
      type: 'taskSourceResult',
      callId: sent[0].callId,
      ok: true,
      value: 'board-status'
    })
    await expect(boards).resolves.toBe('board-status')
    await expect(issues).resolves.toBe('issue-status')
  })

  it('rejects a task source call the worker reports as failed', async () => {
    const child = new FakeChild()
    const pending = start(child)
    child.emit('message', { type: 'ready', commands: [], taskSources: ['boards'] })
    const handle = await pending

    const call = handle.invokeTaskSource('boards', 'status')
    child.emit('message', {
      type: 'taskSourceResult',
      callId: 0,
      ok: false,
      error: 'boards is offline'
    })

    await expect(call).rejects.toThrow('boards is offline')
  })

  it('rejects in-flight task source calls when the worker exits', async () => {
    const child = new FakeChild()
    const pending = start(child)
    child.emit('message', { type: 'ready', commands: [], taskSources: ['boards'] })
    const handle = await pending

    const call = handle.invokeTaskSource('boards', 'status')
    child.emit('exit', 1)

    await expect(call).rejects.toThrow('exited before responding')
  })

  it('counts delivered events as in flight until their acknowledgement', async () => {
    const child = new FakeChild()
    const pending = start(child)
    child.emit('message', { type: 'ready', commands: [] })
    const handle = await pending

    handle.deliverEvent('worktree.created', {
      worktreeId: 'worktree-1',
      path: '/repo',
      branch: 'feature'
    })

    expect(handle.inFlightCount()).toBe(1)
    child.emit('message', { type: 'eventAck', eventId: 0 })
    expect(handle.inFlightCount()).toBe(0)
  })

  it('kills a worker whose event handler never acknowledges completion', async () => {
    vi.useFakeTimers()
    const child = new FakeChild()
    const pending = start(child, { eventTimeoutMs: 25 })
    child.emit('message', { type: 'ready', commands: [] })
    const handle = await pending

    handle.deliverEvent('worktree.created', {
      worktreeId: 'worktree-1',
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
    child.emit('message', { type: 'ready', commands: [] })
    const handle = await pending

    for (let index = 0; index < 65; index += 1) {
      handle.deliverEvent('agent.status.changed', {
        worktreeId: null,
        paneKey: `pane-${index}`,
        state: 'working',
        receivedAt: Date.now()
      })
    }

    expect(handle.inFlightCount()).toBe(64)
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  })
})
