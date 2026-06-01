import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RelayDispatcher } from './dispatcher'

const mocks = vi.hoisted(() => {
  const instances: MockLspProcessSession[] = []
  const resolveLanguageServerCommandMock = vi.fn()

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

  return { instances, MockLspProcessSession, resolveLanguageServerCommandMock }
})

vi.mock('../main/lsp/language-server-registry', () => ({
  resolveLanguageServerCommand: mocks.resolveLanguageServerCommandMock
}))

vi.mock('../main/lsp/lsp-process-session', () => ({
  LspProcessSession: mocks.MockLspProcessSession
}))

import { LspHandler } from './lsp-handler'

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

function createMockDispatcher() {
  const requestHandlers = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>()
  return {
    onRequest: vi.fn(
      (method: string, handler: (params: Record<string, unknown>) => Promise<unknown>) => {
        requestHandlers.set(method, handler)
      }
    ),
    notify: vi.fn(),
    async callRequest(method: string, params: Record<string, unknown> = {}) {
      const handler = requestHandlers.get(method)
      if (!handler) {
        throw new Error(`No handler for ${method}`)
      }
      return handler(params)
    }
  }
}

describe('LspHandler session ownership', () => {
  beforeEach(() => {
    mocks.instances.length = 0
    mocks.resolveLanguageServerCommandMock.mockReset()
    mocks.resolveLanguageServerCommandMock.mockResolvedValue({
      ok: true,
      command: { command: '/usr/bin/clangd', args: [] }
    })
  })

  it('dedupes concurrent relay session creation for the same key', async () => {
    const discovery = deferred<{
      ok: true
      command: { command: string; args: string[] }
    }>()
    mocks.resolveLanguageServerCommandMock.mockReturnValue(discovery.promise)
    const dispatcher = createMockDispatcher()
    const handler = new LspHandler(dispatcher as unknown as RelayDispatcher)

    const firstOpen = dispatcher.callRequest('lsp.openDocument', {
      worktreeId: 'wt-1',
      worktreePath: '/repo',
      filePath: '/repo/a.c',
      languageId: 'c',
      content: 'int a;'
    })
    const secondOpen = dispatcher.callRequest('lsp.openDocument', {
      worktreeId: 'wt-1',
      worktreePath: '/repo',
      filePath: '/repo/b.c',
      languageId: 'c',
      content: 'int b;'
    })
    await Promise.resolve()
    expect(mocks.resolveLanguageServerCommandMock).toHaveBeenCalledTimes(1)

    discovery.resolve({ ok: true, command: { command: '/usr/bin/clangd', args: [] } })
    await Promise.all([firstOpen, secondOpen])

    expect(mocks.instances).toHaveLength(1)
    expect(mocks.instances[0].documents).toEqual(new Set(['/repo/a.c', '/repo/b.c']))
    await handler.dispose()
  })

  it('reopens tracked documents when recovering a lost relay session', async () => {
    const dispatcher = createMockDispatcher()
    const handler = new LspHandler(dispatcher as unknown as RelayDispatcher)

    await dispatcher.callRequest('lsp.openDocument', {
      worktreeId: 'wt-1',
      worktreePath: '/repo',
      filePath: '/repo/main.c',
      languageId: 'c',
      content: 'int before;'
    })
    await dispatcher.callRequest('lsp.changeDocument', {
      worktreePath: '/repo',
      filePath: '/repo/main.c',
      languageId: 'c',
      content: 'int after;'
    })
    const crashed = mocks.instances[0]
    crashed.completion.mockRejectedValueOnce(new Error('server exited'))

    await expect(
      dispatcher.callRequest('lsp.completion', {
        worktreeId: 'wt-1',
        worktreePath: '/repo',
        filePath: '/repo/main.c',
        languageId: 'c',
        position: { line: 0, character: 4 }
      })
    ).resolves.toBeNull()

    expect(mocks.instances).toHaveLength(2)
    expect(mocks.instances[1].openDocument).toHaveBeenCalledWith('/repo/main.c', 'c', 'int after;')
    expect(mocks.instances[1].completion).toHaveBeenCalledWith(
      '/repo/main.c',
      { line: 0, character: 4 },
      undefined
    )
    await handler.dispose()
  })

  it('recreates a relay session when edits arrive after a server crash', async () => {
    const dispatcher = createMockDispatcher()
    const handler = new LspHandler(dispatcher as unknown as RelayDispatcher)

    await dispatcher.callRequest('lsp.openDocument', {
      worktreeId: 'wt-1',
      worktreePath: '/repo',
      filePath: '/repo/main.c',
      languageId: 'c',
      content: 'int before;'
    })
    const crashed = mocks.instances[0]
    crashed.changeDocument.mockRejectedValueOnce(new Error('server exited'))

    await dispatcher.callRequest('lsp.changeDocument', {
      worktreePath: '/repo',
      filePath: '/repo/main.c',
      languageId: 'c',
      content: 'int after;'
    })

    expect(mocks.instances).toHaveLength(2)
    expect(mocks.instances[1].openDocument).toHaveBeenCalledWith('/repo/main.c', 'c', 'int after;')
    expect(mocks.instances[1].changeDocument).toHaveBeenCalledWith('/repo/main.c', 'int after;')
    expect(dispatcher.notify).toHaveBeenCalledWith(
      'lsp.diagnostics',
      expect.objectContaining({
        filePath: '/repo/main.c',
        diagnostics: []
      })
    )
    await handler.dispose()
  })

  it('keeps a relay LSP document open until all views close it', async () => {
    const dispatcher = createMockDispatcher()
    const handler = new LspHandler(dispatcher as unknown as RelayDispatcher)

    await dispatcher.callRequest('lsp.openDocument', {
      worktreeId: 'wt-1',
      worktreePath: '/repo',
      filePath: '/repo/main.c',
      languageId: 'c',
      content: 'int first;',
      documentId: 'doc-1'
    })
    await dispatcher.callRequest('lsp.openDocument', {
      worktreeId: 'wt-1',
      worktreePath: '/repo',
      filePath: '/repo/main.c',
      languageId: 'c',
      content: 'int second;',
      documentId: 'doc-2'
    })
    const session = mocks.instances[0]

    await dispatcher.callRequest('lsp.closeDocument', {
      worktreePath: '/repo',
      filePath: '/repo/main.c',
      languageId: 'c',
      documentId: 'doc-1'
    })

    expect(session.closeDocument).not.toHaveBeenCalled()

    await dispatcher.callRequest('lsp.closeDocument', {
      worktreePath: '/repo',
      filePath: '/repo/main.c',
      languageId: 'c',
      documentId: 'doc-2'
    })

    expect(session.closeDocument).toHaveBeenCalledTimes(1)
    await handler.dispose()
  })

  it('does not spawn a relay session after shutdown while creation is pending', async () => {
    const discovery = deferred<{
      ok: true
      command: { command: string; args: string[] }
    }>()
    mocks.resolveLanguageServerCommandMock.mockReturnValue(discovery.promise)
    const dispatcher = createMockDispatcher()
    const handler = new LspHandler(dispatcher as unknown as RelayDispatcher)

    const open = dispatcher.callRequest('lsp.openDocument', {
      worktreeId: 'wt-1',
      worktreePath: '/repo',
      filePath: '/repo/a.c',
      languageId: 'c',
      content: 'int a;'
    })
    await Promise.resolve()
    await handler.dispose()
    discovery.resolve({ ok: true, command: { command: '/usr/bin/clangd', args: [] } })

    await expect(open).rejects.toThrow('LSP handler is shutting down')
    expect(mocks.instances).toHaveLength(0)
  })
})
