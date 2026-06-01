/* eslint-disable max-lines -- Why: LspService owns local and SSH lifecycle
recovery; keeping the paired regression tests together prevents the two paths
from drifting. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LspDocumentContext, LspRequestContext } from '../../shared/lsp-types'

const mocks = vi.hoisted(() => {
  const instances: MockLspProcessSession[] = []
  const resolveLanguageServerCommandMock = vi.fn()
  const getAllWindowsMock = vi.fn(() => [])
  const multiplexerReadyListeners = new Set<(connectionId: string) => void>()

  class MockLspProcessSession {
    readonly documents = new Set<string>()
    readonly openDocument = vi.fn(async (filePath: string) => {
      this.documents.add(filePath)
    })
    readonly changeDocument = vi.fn(async (filePath: string) => {
      this.documents.add(filePath)
    })
    readonly closeDocument = vi.fn(async (filePath: string) => {
      this.documents.delete(filePath)
    })
    readonly dispose = vi.fn(async () => undefined)
    readonly completion = vi.fn(async () => null)
    readonly hover = vi.fn(async () => null)
    readonly definition = vi.fn(async () => [])
    readonly getOpenDocumentCount = vi.fn(() => this.documents.size)
    readonly getStats = vi.fn(() => ({
      startedAt: 0,
      initializedAt: 0,
      requestCount: 0,
      notificationCount: 0,
      openDocumentCount: this.documents.size
    }))

    constructor() {
      instances.push(this)
    }
  }

  return {
    instances,
    MockLspProcessSession,
    getAllWindowsMock,
    multiplexerReadyListeners,
    resolveLanguageServerCommandMock
  }
})

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: mocks.getAllWindowsMock
  }
}))

vi.mock('../ipc/ssh', () => ({
  getActiveMultiplexer: vi.fn(() => null),
  onActiveMultiplexerReady: vi.fn((listener: (connectionId: string) => void) => {
    mocks.multiplexerReadyListeners.add(listener)
    return () => mocks.multiplexerReadyListeners.delete(listener)
  })
}))

vi.mock('./language-server-registry', () => ({
  resolveLanguageServerCommand: mocks.resolveLanguageServerCommandMock
}))

vi.mock('./lsp-process-session', () => ({
  LspProcessSession: mocks.MockLspProcessSession
}))

import { getActiveMultiplexer, onActiveMultiplexerReady } from '../ipc/ssh'
import { LspService } from './lsp-service'

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

function documentArgs(overrides: Partial<LspDocumentContext> = {}): LspDocumentContext {
  return {
    worktreeId: 'wt-1',
    worktreePath: '/repo',
    filePath: '/repo/main.c',
    languageId: 'c',
    content: 'int main(void) { return 0; }',
    ...overrides
  }
}

function requestArgs(overrides: Partial<LspRequestContext> = {}): LspRequestContext {
  return {
    ...documentArgs(),
    content: undefined,
    position: { line: 0, character: 4 },
    ...overrides
  }
}

function createMuxMock() {
  const disposeCallbacks: (() => void)[] = []
  return {
    isDisposed: vi.fn(() => false),
    request: vi.fn(async (method: string) =>
      method === 'lsp.openDocument' ? { state: 'available', languageId: 'c' } : null
    ),
    onNotificationByMethod: vi.fn(() => vi.fn()),
    onDispose: vi.fn((callback: () => void) => {
      disposeCallbacks.push(callback)
      return vi.fn()
    }),
    disposeMux: () => {
      for (const callback of disposeCallbacks) {
        callback()
      }
    }
  }
}

describe('LspService', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.instances.length = 0
    mocks.getAllWindowsMock.mockReset()
    mocks.getAllWindowsMock.mockReturnValue([] as never)
    mocks.multiplexerReadyListeners.clear()
    mocks.resolveLanguageServerCommandMock.mockReset()
    mocks.resolveLanguageServerCommandMock.mockResolvedValue({
      ok: true,
      command: { command: '/usr/bin/clangd', args: [] }
    })
    vi.mocked(getActiveMultiplexer).mockReset()
    vi.mocked(getActiveMultiplexer).mockReturnValue(null as never)
    vi.mocked(onActiveMultiplexerReady).mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not start a language-server process when only checking status', async () => {
    const service = new LspService()

    await expect(
      service.getStatus({ worktreePath: '/repo', languageId: 'c' })
    ).resolves.toMatchObject({ state: 'available', languageId: 'c' })

    expect(mocks.instances).toHaveLength(0)
  })

  it('delays shutdown after the last local document closes and cancels it on quick return', async () => {
    const service = new LspService()
    await service.openDocument(documentArgs())
    const session = mocks.instances[0]

    await service.closeDocument(documentArgs())

    expect(session.dispose).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(59_999)
    expect(session.dispose).not.toHaveBeenCalled()

    await service.openDocument(documentArgs({ filePath: '/repo/other.c', content: 'int other;' }))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(session.dispose).not.toHaveBeenCalled()

    await service.closeDocument(documentArgs({ filePath: '/repo/other.c' }))
    await vi.advanceTimersByTimeAsync(60_000)

    expect(session.dispose).toHaveBeenCalledTimes(1)
  })

  it('dedupes concurrent local session creation for the same key', async () => {
    const discovery = deferred<{
      ok: true
      command: { command: string; args: string[] }
    }>()
    mocks.resolveLanguageServerCommandMock.mockReturnValue(discovery.promise)
    const service = new LspService()

    const firstOpen = service.openDocument(documentArgs({ filePath: '/repo/a.c' }))
    const secondOpen = service.openDocument(documentArgs({ filePath: '/repo/b.c' }))
    await Promise.resolve()
    expect(mocks.resolveLanguageServerCommandMock).toHaveBeenCalledTimes(1)

    discovery.resolve({ ok: true, command: { command: '/usr/bin/clangd', args: [] } })
    await Promise.all([firstOpen, secondOpen])

    expect(mocks.instances).toHaveLength(1)
    expect(mocks.instances[0].documents).toEqual(new Set(['/repo/a.c', '/repo/b.c']))
  })

  it('reopens tracked documents when recovering a lost local session', async () => {
    const service = new LspService()
    await service.openDocument(documentArgs({ content: 'int before;' }))
    await service.changeDocument(documentArgs({ content: 'int after;' }))
    const crashed = mocks.instances[0]
    crashed.completion.mockRejectedValueOnce(new Error('server exited'))

    await expect(service.completion(requestArgs())).resolves.toBeNull()

    expect(mocks.instances).toHaveLength(2)
    expect(mocks.instances[1].openDocument).toHaveBeenCalledWith('/repo/main.c', 'c', 'int after;')
    expect(mocks.instances[1].completion).toHaveBeenCalledWith(
      '/repo/main.c',
      { line: 0, character: 4 },
      undefined
    )
  })

  it('recreates a local session when edits arrive after a server crash', async () => {
    const send = vi.fn()
    mocks.getAllWindowsMock.mockReturnValue([
      {
        isDestroyed: () => false,
        webContents: { send }
      }
    ] as never)
    const service = new LspService()
    await service.openDocument(documentArgs({ content: 'int before;' }))
    const crashed = mocks.instances[0]
    crashed.changeDocument.mockRejectedValueOnce(new Error('server exited'))

    await service.changeDocument(documentArgs({ content: 'int after;' }))

    expect(mocks.instances).toHaveLength(2)
    expect(mocks.instances[1].openDocument).toHaveBeenCalledWith('/repo/main.c', 'c', 'int after;')
    expect(mocks.instances[1].changeDocument).toHaveBeenCalledWith('/repo/main.c', 'int after;')
    expect(send).toHaveBeenCalledWith(
      'lsp:diagnostics',
      expect.objectContaining({
        filePath: '/repo/main.c',
        diagnostics: []
      })
    )
  })

  it('keeps a local LSP document open until all views close it', async () => {
    const service = new LspService()
    await service.openDocument(documentArgs({ content: 'int first;', documentId: 'doc-1' }))
    await service.openDocument(documentArgs({ content: 'int second;', documentId: 'doc-2' }))
    const session = mocks.instances[0]

    await service.closeDocument(documentArgs({ documentId: 'doc-1' }))

    expect(session.closeDocument).not.toHaveBeenCalled()

    await service.closeDocument(documentArgs({ documentId: 'doc-2' }))

    expect(session.closeDocument).toHaveBeenCalledTimes(1)
  })

  it('does not spawn a local session after shutdown while creation is pending', async () => {
    const discovery = deferred<{
      ok: true
      command: { command: string; args: string[] }
    }>()
    mocks.resolveLanguageServerCommandMock.mockReturnValue(discovery.promise)
    const service = new LspService()

    const open = service.openDocument(documentArgs())
    await Promise.resolve()
    await service.disposeAll()
    discovery.resolve({ ok: true, command: { command: '/usr/bin/clangd', args: [] } })

    await expect(open).rejects.toThrow('LSP service is shutting down')
    expect(mocks.instances).toHaveLength(0)
  })

  it('re-registers remote diagnostics when rehydrating documents on a new SSH mux', async () => {
    const firstMux = createMuxMock()
    const secondMux = createMuxMock()
    vi.mocked(getActiveMultiplexer).mockReturnValue(firstMux as never)
    const service = new LspService()

    await service.openDocument(documentArgs({ connectionId: 'ssh-1', content: 'int before;' }))
    expect(firstMux.onNotificationByMethod).toHaveBeenCalledTimes(1)

    vi.mocked(getActiveMultiplexer).mockReturnValue(secondMux as never)
    await service.completion(requestArgs({ connectionId: 'ssh-1' }))

    expect(secondMux.onNotificationByMethod).toHaveBeenCalledTimes(1)
    expect(secondMux.request).toHaveBeenCalledWith(
      'lsp.openDocument',
      expect.objectContaining({
        connectionId: 'ssh-1',
        filePath: '/repo/main.c',
        content: 'int before;'
      })
    )
    expect(secondMux.request).toHaveBeenCalledWith(
      'lsp.completion',
      expect.objectContaining({ filePath: '/repo/main.c' })
    )
  })

  it('returns unavailable when an older SSH relay does not support LSP status', async () => {
    const mux = createMuxMock()
    mux.request.mockRejectedValueOnce(
      Object.assign(new Error('Method not found: lsp.getStatus'), {
        code: -32601
      })
    )
    vi.mocked(getActiveMultiplexer).mockReturnValue(mux as never)
    const service = new LspService()

    await expect(
      service.getStatus({ worktreePath: '/repo', languageId: 'c', connectionId: 'ssh-1' })
    ).resolves.toMatchObject({
      state: 'unavailable',
      languageId: 'c',
      reason: expect.stringContaining('Remote relay does not support LSP')
    })
  })

  it('reopens remote documents before forwarding edits on a new SSH mux', async () => {
    const firstMux = createMuxMock()
    const secondMux = createMuxMock()
    vi.mocked(getActiveMultiplexer).mockReturnValue(firstMux as never)
    const service = new LspService()

    await service.openDocument(documentArgs({ connectionId: 'ssh-1', content: 'int before;' }))

    vi.mocked(getActiveMultiplexer).mockReturnValue(secondMux as never)
    await service.changeDocument(documentArgs({ connectionId: 'ssh-1', content: 'int after;' }))

    expect(secondMux.request).toHaveBeenCalledWith(
      'lsp.openDocument',
      expect.objectContaining({
        connectionId: 'ssh-1',
        filePath: '/repo/main.c',
        content: 'int after;'
      })
    )
    expect(secondMux.request).toHaveBeenCalledWith(
      'lsp.changeDocument',
      expect.objectContaining({
        connectionId: 'ssh-1',
        filePath: '/repo/main.c',
        content: 'int after;'
      })
    )
  })

  it('eagerly reopens tracked remote documents when an SSH mux becomes ready', async () => {
    const firstMux = createMuxMock()
    const secondMux = createMuxMock()
    vi.mocked(getActiveMultiplexer).mockReturnValue(firstMux as never)
    const service = new LspService()

    await service.openDocument(
      documentArgs({ connectionId: 'ssh-1', content: 'int before;', documentId: 'doc-1' })
    )

    vi.mocked(getActiveMultiplexer).mockReturnValue(secondMux as never)
    for (const listener of mocks.multiplexerReadyListeners) {
      listener('ssh-1')
    }
    await flushPromises()

    expect(secondMux.onNotificationByMethod).toHaveBeenCalledTimes(1)
    expect(secondMux.request).toHaveBeenCalledWith(
      'lsp.openDocument',
      expect.objectContaining({
        connectionId: 'ssh-1',
        filePath: '/repo/main.c',
        documentId: 'doc-1',
        content: 'int before;'
      })
    )

    await service.disposeAll()
    expect(mocks.multiplexerReadyListeners.size).toBe(0)
  })

  it('reopens tracked remote documents when an SSH relay reconnects on the same mux', async () => {
    const mux = createMuxMock()
    vi.mocked(getActiveMultiplexer).mockReturnValue(mux as never)
    const service = new LspService()

    await service.openDocument(
      documentArgs({ connectionId: 'ssh-1', content: 'int before;', documentId: 'doc-1' })
    )
    mux.request.mockClear()

    for (const listener of mocks.multiplexerReadyListeners) {
      listener('ssh-1')
    }
    await flushPromises()

    expect(mux.request).toHaveBeenCalledWith(
      'lsp.openDocument',
      expect.objectContaining({
        connectionId: 'ssh-1',
        filePath: '/repo/main.c',
        documentId: 'doc-1',
        content: 'int before;'
      })
    )
  })

  it('does not double-count a remote document reopened after SSH reconnect', async () => {
    const firstMux = createMuxMock()
    const secondMux = createMuxMock()
    vi.mocked(getActiveMultiplexer).mockReturnValue(firstMux as never)
    const service = new LspService()

    await service.openDocument(
      documentArgs({ connectionId: 'ssh-1', content: 'int before;', documentId: 'doc-1' })
    )

    vi.mocked(getActiveMultiplexer).mockReturnValue(secondMux as never)
    await service.openDocument(
      documentArgs({ connectionId: 'ssh-1', content: 'int after;', documentId: 'doc-1' })
    )
    await service.closeDocument(documentArgs({ connectionId: 'ssh-1', documentId: 'doc-1' }))

    expect(secondMux.request).toHaveBeenCalledWith(
      'lsp.closeDocument',
      expect.objectContaining({ filePath: '/repo/main.c', documentId: 'doc-1' })
    )
  })

  it('replays every remote document id for a multi-view file after SSH reconnect', async () => {
    const firstMux = createMuxMock()
    const secondMux = createMuxMock()
    vi.mocked(getActiveMultiplexer).mockReturnValue(firstMux as never)
    const service = new LspService()

    await service.openDocument(
      documentArgs({ connectionId: 'ssh-1', content: 'int first;', documentId: 'doc-1' })
    )
    await service.openDocument(
      documentArgs({ connectionId: 'ssh-1', content: 'int second;', documentId: 'doc-2' })
    )

    vi.mocked(getActiveMultiplexer).mockReturnValue(secondMux as never)
    await service.completion(requestArgs({ connectionId: 'ssh-1' }))

    expect(secondMux.request).toHaveBeenCalledWith(
      'lsp.openDocument',
      expect.objectContaining({ filePath: '/repo/main.c', documentId: 'doc-1' })
    )
    expect(secondMux.request).toHaveBeenCalledWith(
      'lsp.openDocument',
      expect.objectContaining({ filePath: '/repo/main.c', documentId: 'doc-2' })
    )
  })

  it('clears tracked remote diagnostics when an SSH mux is disposed', async () => {
    const mux = createMuxMock()
    const send = vi.fn()
    mocks.getAllWindowsMock.mockReturnValue([
      {
        isDestroyed: () => false,
        webContents: { send }
      }
    ] as never)
    vi.mocked(getActiveMultiplexer).mockReturnValue(mux as never)
    const service = new LspService()

    await service.openDocument(documentArgs({ connectionId: 'ssh-1', content: 'int before;' }))

    mux.disposeMux()

    expect(send).toHaveBeenCalledWith(
      'lsp:diagnostics',
      expect.objectContaining({
        connectionId: 'ssh-1',
        filePath: '/repo/main.c',
        diagnostics: []
      })
    )
  })
})
