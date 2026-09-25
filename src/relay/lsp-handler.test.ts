import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { LspHandler, type LspSpawnFn } from './lsp-handler'
import type { RequestContext } from './dispatcher'
import { JSON_RPC_METHOD_NOT_FOUND_CODE } from '../shared/lsp-relay-channel'

// A fake `node:child_process` ChildProcess: EventEmitter + stdio pipes the
// handler attaches listeners to. Mirrors agent-exec-handler-test-harness.
type FakeChild = EventEmitter & {
  pid: number
  kill: Mock
  stdout: EventEmitter & { pause: Mock; resume: Mock; setEncoding: Mock }
  stderr: EventEmitter & { setEncoding: Mock }
  stdin: { write: Mock; end: Mock; on: Mock }
  unref: Mock
}

function createFakeChild(): FakeChild {
  const stdout = Object.assign(new EventEmitter(), {
    pause: vi.fn(),
    resume: vi.fn(),
    // Real Readable.setEncoding returns the stream for chaining.
    setEncoding: vi.fn().mockReturnThis()
  })
  const stderr = Object.assign(new EventEmitter(), {
    setEncoding: vi.fn().mockReturnThis()
  })
  return Object.assign(new EventEmitter(), {
    pid: 4242,
    kill: vi.fn(),
    stdout,
    stderr,
    stdin: { write: vi.fn(), end: vi.fn(), on: vi.fn() },
    unref: vi.fn()
  })
}

type CapturedNotification = { clientId: number; method: string; params: Record<string, unknown> }

function createMockDispatcher() {
  const requestHandlers = new Map<
    string,
    (p: Record<string, unknown>, ctx: RequestContext) => unknown
  >()
  const notificationHandlers = new Map<string, (p: Record<string, unknown>) => void>()
  const disposedListeners = new Set<() => void>()
  const notifications: CapturedNotification[] = []
  const dispatcher = {
    onRequest: vi.fn(
      (method: string, handler: (p: Record<string, unknown>, ctx: RequestContext) => unknown) => {
        requestHandlers.set(method, handler)
      }
    ),
    onNotification: vi.fn((method: string, handler: (p: Record<string, unknown>) => void) => {
      if (notificationHandlers.has(method)) {
        throw new Error(`Notification handler for ${method} is already registered`)
      }
      notificationHandlers.set(method, handler)
    }),
    publishProducerNotification: vi.fn(
      (clientId: number, method: string, params?: Record<string, unknown>) => {
        notifications.push({ clientId, method, params: params ?? {} })
        return true
      }
    ),
    onDisposed: vi.fn((listener: () => void) => {
      disposedListeners.add(listener)
      return () => disposedListeners.delete(listener)
    }),
    _requestHandlers: requestHandlers,
    _notificationHandlers: notificationHandlers,
    _disposedListeners: disposedListeners,
    _notifications: notifications,
    async callRequest(method: string, params: Record<string, unknown> = {}, ctx?: RequestContext) {
      const handler = requestHandlers.get(method)
      if (!handler) {
        const err = new Error(`Method not found: ${method}`) as Error & { code: number }
        err.code = JSON_RPC_METHOD_NOT_FOUND_CODE
        throw err
      }
      return handler(params, ctx ?? { clientId: 1, isStale: () => false })
    },
    callNotification(method: string, params: Record<string, unknown> = {}) {
      const handler = notificationHandlers.get(method)
      if (!handler) {
        return
      }
      handler(params)
    }
  }
  return dispatcher
}

/** Builds a handler + dispatcher + fake child for one test. */
function setup(spawnChild: FakeChild = createFakeChild()) {
  const dispatcher = createMockDispatcher()
  const calls = vi.fn()
  const fn: LspSpawnFn = (program, args, options) => {
    calls(program, args, options)
    return spawnChild as never
  }
  const handler = new LspHandler(dispatcher as never, fn)
  return { dispatcher, handler, child: spawnChild, spawnCalls: calls }
}

describe('LspHandler (relay lsp.* family)', () => {
  it('registers lsp.spawn/kill requests and lsp.write/ack notifications', () => {
    const { dispatcher } = setup()
    expect(dispatcher.onRequest).toHaveBeenCalledWith('lsp.spawn', expect.any(Function))
    expect(dispatcher.onRequest).toHaveBeenCalledWith('lsp.kill', expect.any(Function))
    expect(dispatcher.onNotification).toHaveBeenCalledWith('lsp.write', expect.any(Function))
    expect(dispatcher.onNotification).toHaveBeenCalledWith('lsp.ack', expect.any(Function))
  })

  it('lsp.spawn returns a session id carrying the relay incarnation epoch', async () => {
    const { dispatcher, handler } = setup()
    const result = (await dispatcher.callRequest('lsp.spawn', {
      program: '/usr/bin/clangd',
      args: ['--log=info'],
      cwd: '/home/u/repo'
    })) as { sessionId: string }
    expect(result.sessionId).toMatch(/^lsp:[^:]+:\d+$/)
    expect(result.sessionId).toContain(encodeURIComponent(handler.mintEpoch()))
    expect(handler.sessionCount).toBe(1)
  })

  it('requires a non-empty program', async () => {
    const { dispatcher } = setup()
    await expect(dispatcher.callRequest('lsp.spawn', { program: '' })).rejects.toThrow(
      /non-empty "program"/
    )
  })

  it('streams stdout as base64 lsp.data frames with monotonic seqs', async () => {
    const child = createFakeChild()
    const { dispatcher } = setup(child)
    const { sessionId } = (await dispatcher.callRequest('lsp.spawn', {
      program: '/usr/bin/clangd'
    })) as { sessionId: string }
    child.stdout.emit('data', Buffer.from('Content-Length: 2\r\n\r\n{}', 'utf8'))
    const dataFrames = dispatcher._notifications.filter((n) => n.method === 'lsp.data')
    expect(dataFrames).toHaveLength(1)
    expect(dataFrames[0].params).toMatchObject({ sessionId })
    expect(dataFrames[0].params.seq).toBe(1)
    expect(Buffer.from(dataFrames[0].params.data as string, 'base64').toString('utf8')).toBe(
      'Content-Length: 2\r\n\r\n{}'
    )
  })

  it('line-buffers stderr into lsp.stderr frames', async () => {
    const child = createFakeChild()
    const { dispatcher } = setup(child)
    await dispatcher.callRequest('lsp.spawn', { program: '/usr/bin/clangd' })
    child.stderr.emit('data', 'line one\nline two\npartial')
    const frames = dispatcher._notifications.filter((n) => n.method === 'lsp.stderr')
    expect(frames.map((f) => f.params.line)).toEqual(['line one', 'line two'])
    child.emit('exit', 0, null)
    const exitFlush = [...dispatcher._notifications]
      .toReversed()
      .find((n) => n.method === 'lsp.stderr')
    expect(exitFlush?.params.line).toBe('partial')
  })

  it('emits lsp.exit once and removes the session', async () => {
    const child = createFakeChild()
    const { dispatcher, handler } = setup(child)
    const { sessionId } = (await dispatcher.callRequest('lsp.spawn', {
      program: '/usr/bin/clangd'
    })) as { sessionId: string }
    child.emit('exit', 0, null)
    const exitFrames = dispatcher._notifications.filter((n) => n.method === 'lsp.exit')
    expect(exitFrames).toHaveLength(1)
    expect(exitFrames[0].params).toMatchObject({ sessionId, code: 0, signal: null })
    expect(handler.sessionCount).toBe(0)
  })

  it('lsp.write writes base64-decoded bytes to stdin', async () => {
    const child = createFakeChild()
    const { dispatcher } = setup(child)
    const { sessionId } = (await dispatcher.callRequest('lsp.spawn', {
      program: '/usr/bin/clangd'
    })) as { sessionId: string }
    dispatcher.callNotification('lsp.write', {
      sessionId,
      data: Buffer.from('hello', 'utf8').toString('base64')
    })
    expect(child.stdin.write).toHaveBeenCalledWith(Buffer.from('hello', 'utf8'))
  })

  it('lsp.write is a no-op for an unknown session', async () => {
    const { dispatcher } = setup()
    dispatcher.callNotification('lsp.write', { sessionId: 'lsp:bogus:9', data: 'aGVsbG8=' })
    // No throw, no crash — graceful.
  })

  it('lsp.kill terminates the process tree', async () => {
    const child = createFakeChild()
    const { dispatcher } = setup(child)
    // The relay runs on a POSIX remote host; tree-termination there is child.kill.
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    try {
      const { sessionId } = (await dispatcher.callRequest('lsp.spawn', {
        program: '/usr/bin/clangd'
      })) as { sessionId: string }
      const result = (await dispatcher.callRequest('lsp.kill', { sessionId })) as {
        killed: boolean
      }
      expect(result.killed).toBe(true)
      expect(child.kill).toHaveBeenCalled()
    } finally {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform?.value ?? 'linux'
      })
    }
  })

  it('lsp.kill on an unknown session reports killed:false (not an error)', async () => {
    const { dispatcher } = setup()
    const result = (await dispatcher.callRequest('lsp.kill', { sessionId: 'lsp:none:1' })) as {
      killed: boolean
    }
    expect(result.killed).toBe(false)
  })

  it('applies credit backpressure: pauses stdout at the window and resumes on ack', async () => {
    const child = createFakeChild()
    const { dispatcher } = setup(child)
    const { sessionId } = (await dispatcher.callRequest('lsp.spawn', {
      program: '/usr/bin/clangd'
    })) as { sessionId: string }
    // Window default = 4. Emit 4 small chunks → 4 lsp.data frames; the 4th send
    // fills the window (unacked == 4 == window) so the next chunk must pause.
    for (let i = 0; i < 4; i++) {
      child.stdout.emit('data', Buffer.from(`chunk${i}`))
    }
    expect(dispatcher._notifications.filter((n) => n.method === 'lsp.data')).toHaveLength(4)
    // A 5th chunk arrives while the window is full → buffered, stdout paused.
    child.stdout.emit('data', Buffer.from('chunk4'))
    expect(child.stdout.pause).toHaveBeenCalled()
    expect(dispatcher._notifications.filter((n) => n.method === 'lsp.data')).toHaveLength(4)
    // Ack seq 1 → window reopens → buffered chunk flushes.
    dispatcher.callNotification('lsp.ack', { sessionId, seq: 1 })
    expect(child.stdout.resume).toHaveBeenCalled()
    expect(dispatcher._notifications.filter((n) => n.method === 'lsp.data')).toHaveLength(5)
  })

  it('detaches all sessions on dispatcher disposal (children survive — execution boundary)', async () => {
    const child = createFakeChild()
    const { dispatcher, handler } = setup(child)
    await dispatcher.callRequest('lsp.spawn', { program: '/usr/bin/clangd' })
    expect(handler.sessionCount).toBe(1)
    for (const listener of dispatcher._disposedListeners) {
      listener()
    }
    // The session stays registered (detached, not killed) — only stdout is paused.
    expect(handler.sessionCount).toBe(1)
    expect(child.stdout.pause).toHaveBeenCalled()
  })

  it('spawns detached and unrefed so the child survives a relay-client disconnect', async () => {
    const child = createFakeChild()
    const { dispatcher, spawnCalls } = setup(child)
    await dispatcher.callRequest('lsp.spawn', { program: '/bin/clangd' })
    expect(spawnCalls).toHaveBeenCalledWith(
      '/bin/clangd',
      expect.any(Array),
      expect.objectContaining({ detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
    )
    expect(child.unref).toHaveBeenCalled()
  })

  it('targets lsp.* notifications only at the owning client', async () => {
    const child = createFakeChild()
    const { dispatcher } = setup(child)
    await dispatcher.callRequest(
      'lsp.spawn',
      { program: '/bin/clangd' },
      {
        clientId: 7,
        isStale: () => false
      }
    )
    child.stdout.emit('data', Buffer.from('hi'))
    expect(dispatcher._notifications.every((n) => n.clientId === 7)).toBe(true)
  })

  it('an old relay without lsp.* handlers answers method_not_found for lsp.spawn', async () => {
    // A dispatcher that never registered lsp.* mirrors an incumbent relay built
    // before ticket 17: the request handler map has no 'lsp.spawn' entry, so the
    // client-facing answer is the JSON-RPC method_not_found error (-32601).
    const bare = createMockDispatcher()
    // No LspHandler constructed — simulates an old relay.
    await expect(bare.callRequest('lsp.spawn', { program: '/bin/clangd' })).rejects.toThrow(
      /Method not found: lsp.spawn/
    )
    // The error carries the -32601 code the client probes for capability.
    await expect(bare.callRequest('lsp.spawn', { program: '/bin/clangd' })).rejects.toMatchObject({
      code: JSON_RPC_METHOD_NOT_FOUND_CODE
    })
  })
})
