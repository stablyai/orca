import { describe, expect, it, vi } from 'vitest'
import {
  createSshHostAdapter,
  SshLspTransportLostError,
  isSshLspTransportLost,
  SSH_LSP_TRANSPORT_LOST_CODE
} from './ssh-language-server-adapter'
import {
  JSON_RPC_METHOD_NOT_FOUND_CODE,
  isLspMethodNotFoundError
} from '../../shared/lsp-relay-channel'
import type { LanguageServerProcessHandlers } from './language-server-host-adapter'

// Minimal mux surface the SSH adapter consumes. Keeps the adapter's
// disconnect/capability/replay logic unit-testable without the full transport.
type MuxMethodNotificationHandler = (params: Record<string, unknown>) => void
type FakeMux = {
  isDisposed: () => boolean
  request: ReturnType<typeof vi.fn>
  notify: ReturnType<typeof vi.fn>
  onNotificationByMethod: ReturnType<typeof vi.fn>
  onDispose: ReturnType<typeof vi.fn>
  // Test helpers
  methodHandlers: Map<string, MuxMethodNotificationHandler>
  disposeHandlers: ((reason: 'shutdown' | 'connection_lost') => void)[]
  emitNotification: (method: string, params: Record<string, unknown>) => void
  fireDispose: (reason: 'shutdown' | 'connection_lost') => void
}

function createFakeMux(): FakeMux {
  const methodHandlers = new Map<string, MuxMethodNotificationHandler>()
  const disposeHandlers: ((reason: 'shutdown' | 'connection_lost') => void)[] = []
  const mux: FakeMux = {
    isDisposed: () => false,
    request: vi.fn(),
    notify: vi.fn(),
    onNotificationByMethod: vi.fn((method: string, handler: MuxMethodNotificationHandler) => {
      methodHandlers.set(method, handler)
      return () => methodHandlers.delete(method)
    }),
    onDispose: vi.fn((handler) => {
      disposeHandlers.push(handler)
      return () => {
        const idx = disposeHandlers.indexOf(handler)
        if (idx !== -1) {
          disposeHandlers.splice(idx, 1)
        }
      }
    }),
    methodHandlers,
    disposeHandlers,
    emitNotification(method, params) {
      methodHandlers.get(method)?.(params)
    },
    fireDispose(reason) {
      for (const h of disposeHandlers) {
        h(reason)
      }
    }
  }
  return mux
}

function createHandlers(): LanguageServerProcessHandlers & {
  calls: { stdout: Buffer[]; stderr: string[]; exit: (Error | null)[] }
} {
  const calls = { stdout: [] as Buffer[], stderr: [] as string[], exit: [] as (Error | null)[] }
  return {
    onStdoutChunk: (chunk) => calls.stdout.push(chunk),
    onStderrLine: (line) => calls.stderr.push(line),
    onExit: (error) => calls.exit.push(error),
    calls
  }
}

describe('SSH host adapter (relay lsp.* channel)', () => {
  it('marks the session unverifiable (never exited) when the relay is not connected', () => {
    // No mux registered for the target — the adapter cannot reach the relay.
    const adapter = createSshHostAdapter('target-absent')
    const handlers = createHandlers()
    const handle = adapter.openProcess(
      { program: 'clangd', args: [], cwd: '/home/u/repo' },
      handlers
    )
    // The dead handle fires onExit with a transport-lost error immediately.
    expect(handlers.calls.exit).toHaveLength(1)
    const error = handlers.calls.exit[0]
    expect(isSshLspTransportLost(error)).toBe(true)
    expect((error as Error & { code?: string }).code).toBe(SSH_LSP_TRANSPORT_LOST_CODE)
    // write/kill are no-ops on the dead handle.
    handle.write(Buffer.from('x'))
    return expect(handle.killTree()).resolves.toBe(true)
  })

  it('routes lsp.spawn and streams lsp.data → stdout, acking each frame', async () => {
    const mux = createFakeMux()
    const { registerSshLspRelay } = await import('../ssh/ssh-lsp-relay-registry')
    registerSshLspRelay('target-1', mux as never)
    // Resolve lsp.spawn with a session id.
    mux.request.mockResolvedValue({ sessionId: 'lsp:epoch:1' })

    const adapter = createSshHostAdapter('target-1')
    const handlers = createHandlers()
    const handle = adapter.openProcess(
      { program: 'clangd', args: ['--log=info'], cwd: '/home/u/repo' },
      handlers
    )
    // Wait a microtask for the spawn promise to settle.
    await Promise.resolve()
    await Promise.resolve()
    // Emit a stdout frame.
    mux.emitNotification('lsp.data', {
      sessionId: 'lsp:epoch:1',
      seq: 1,
      data: Buffer.from('Content-Length: 2\r\n\r\n{}', 'utf8').toString('base64')
    })
    expect(handlers.calls.stdout.map((b) => b.toString('utf8'))).toEqual([
      'Content-Length: 2\r\n\r\n{}'
    ])
    // The client acked seq 1 to release the relay's credit window.
    expect(mux.notify).toHaveBeenCalledWith('lsp.ack', { sessionId: 'lsp:epoch:1', seq: 1 })
    // Cleanup so the registered mux does not leak into other tests.
    const { unregisterSshLspRelay } = await import('../ssh/ssh-lsp-relay-registry')
    unregisterSshLspRelay('target-1')
    void handle
  })

  it('buffers writes until the lsp.spawn sessionId resolves, then flushes', async () => {
    const mux = createFakeMux()
    const { registerSshLspRelay } = await import('../ssh/ssh-lsp-relay-registry')
    registerSshLspRelay('target-2', mux as never)
    let resolveSpawn: (v: { sessionId: string }) => void
    mux.request.mockReturnValue(
      new Promise((resolve) => {
        resolveSpawn = resolve
      })
    )
    const adapter = createSshHostAdapter('target-2')
    const handlers = createHandlers()
    const handle = adapter.openProcess(
      { program: 'clangd', args: [], cwd: '/home/u/repo' },
      handlers
    )
    // Write before spawn resolves — buffered, not sent.
    handle.write(Buffer.from('initialize'))
    expect(mux.notify).not.toHaveBeenCalledWith('lsp.write', expect.anything())
    // Resolve the spawn.
    resolveSpawn!({ sessionId: 'lsp:epoch:2' })
    await Promise.resolve()
    await Promise.resolve()
    expect(mux.notify).toHaveBeenCalledWith(
      'lsp.write',
      expect.objectContaining({ sessionId: 'lsp:epoch:2' })
    )
    const { unregisterSshLspRelay } = await import('../ssh/ssh-lsp-relay-registry')
    unregisterSshLspRelay('target-2')
  })

  it('transport loss (mux connection_lost) fires unverifiable, never exited', async () => {
    const mux = createFakeMux()
    const { registerSshLspRelay, unregisterSshLspRelay } =
      await import('../ssh/ssh-lsp-relay-registry')
    registerSshLspRelay('target-3', mux as never)
    mux.request.mockResolvedValue({ sessionId: 'lsp:epoch:3' })
    const adapter = createSshHostAdapter('target-3')
    const handlers = createHandlers()
    adapter.openProcess({ program: 'clangd', args: [], cwd: '/r' }, handlers)
    await Promise.resolve()
    await Promise.resolve()
    // The relay channel drops.
    mux.fireDispose('connection_lost')
    expect(handlers.calls.exit).toHaveLength(1)
    expect(isSshLspTransportLost(handlers.calls.exit[0])).toBe(true)
    unregisterSshLspRelay('target-3')
  })

  it('host-acknowledged lsp.exit fires a clean exit (positive death evidence)', async () => {
    const mux = createFakeMux()
    const { registerSshLspRelay, unregisterSshLspRelay } =
      await import('../ssh/ssh-lsp-relay-registry')
    registerSshLspRelay('target-4', mux as never)
    mux.request.mockResolvedValue({ sessionId: 'lsp:epoch:4' })
    const adapter = createSshHostAdapter('target-4')
    const handlers = createHandlers()
    adapter.openProcess({ program: 'clangd', args: [], cwd: '/r' }, handlers)
    await Promise.resolve()
    await Promise.resolve()
    mux.emitNotification('lsp.exit', { sessionId: 'lsp:epoch:4', code: 0, signal: null })
    expect(handlers.calls.exit).toEqual([null])
    unregisterSshLspRelay('target-4')
  })

  it('old relay (method_not_found on lsp.spawn) degrades — reports exit, no hang', async () => {
    const mux = createFakeMux()
    const { registerSshLspRelay, unregisterSshLspRelay } =
      await import('../ssh/ssh-lsp-relay-registry')
    registerSshLspRelay('target-5', mux as never)
    const notFound = Object.assign(new Error('Method not found: lsp.spawn'), {
      code: JSON_RPC_METHOD_NOT_FOUND_CODE
    })
    mux.request.mockRejectedValue(notFound)
    const adapter = createSshHostAdapter('target-5')
    const handlers = createHandlers()
    adapter.openProcess({ program: 'clangd', args: [], cwd: '/r' }, handlers)
    await Promise.resolve()
    await Promise.resolve()
    expect(handlers.calls.exit).toHaveLength(1)
    const error = handlers.calls.exit[0] as Error & { code?: string }
    expect(error.code).toBe('LSP_METHOD_NOT_FOUND')
    expect(error.message).toMatch(/relay too old/i)
    unregisterSshLspRelay('target-5')
  })

  it('killTree routes lsp.kill to the relay', async () => {
    const mux = createFakeMux()
    const { registerSshLspRelay, unregisterSshLspRelay } =
      await import('../ssh/ssh-lsp-relay-registry')
    registerSshLspRelay('target-6', mux as never)
    mux.request.mockResolvedValue({ sessionId: 'lsp:epoch:6' })
    // The second request (lsp.kill) resolves.
    mux.request.mockImplementation(async (method: string) =>
      method === 'lsp.spawn' ? { sessionId: 'lsp:epoch:6' } : { killed: true }
    )
    const adapter = createSshHostAdapter('target-6')
    const handlers = createHandlers()
    const handle = adapter.openProcess({ program: 'clangd', args: [], cwd: '/r' }, handlers)
    await Promise.resolve()
    await Promise.resolve()
    await handle.killTree()
    expect(mux.request).toHaveBeenCalledWith(
      'lsp.kill',
      expect.objectContaining({ sessionId: 'lsp:epoch:6' })
    )
    unregisterSshLspRelay('target-6')
  })

  it('path mapping reuses native POSIX rules (remote clangd sees its own paths)', () => {
    const adapter = createSshHostAdapter('target-7')
    expect(adapter.pathToLspUri('/home/u/repo/a.cpp')).toBe('file:///home/u/repo/a.cpp')
    expect(adapter.lspUriToPath('file:///home/u/repo/a.cpp')).toBe('/home/u/repo/a.cpp')
  })

  it('isLspMethodNotFoundError detects both numeric and stringified codes', () => {
    expect(isLspMethodNotFoundError(Object.assign(new Error('x'), { code: -32601 }))).toBe(true)
    expect(
      isLspMethodNotFoundError(Object.assign(new Error('x'), { code: 'method_not_found' }))
    ).toBe(true)
    expect(isLspMethodNotFoundError(Object.assign(new Error('x'), { code: -32000 }))).toBe(false)
    expect(isLspMethodNotFoundError(new Error('x'))).toBe(false)
    expect(isLspMethodNotFoundError(null)).toBe(false)
  })

  it('SshLspTransportLostError carries the connection_lost code', () => {
    const error = new SshLspTransportLostError()
    expect(error.code).toBe(SSH_LSP_TRANSPORT_LOST_CODE)
    expect(isSshLspTransportLost(error)).toBe(true)
    expect(error.message).toMatch(/unverifiable/)
  })
})
