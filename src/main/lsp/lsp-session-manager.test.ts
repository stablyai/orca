import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { pathToFileURL } from 'node:url'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { encodeLspMessage, LspMessageDecoder } from './lsp-message-framing'
import { createLspSessionManager } from './lsp-session-manager'

type JsonRpcMessage = {
  jsonrpc: '2.0'
  id?: number
  method?: string
  params?: unknown
  result?: unknown
}

/** Fake server that auto-answers `initialize` and records everything sent to it. */
function createFakeServer(serverCapabilities: Record<string, unknown> = {}) {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams & EventEmitter
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  Object.assign(child, { stdin, stdout, stderr: new PassThrough(), kill: vi.fn() })

  const received: JsonRpcMessage[] = []
  const decoder = new LspMessageDecoder()
  stdin.on('data', (chunk: Buffer) => {
    for (const message of decoder.push(chunk) as JsonRpcMessage[]) {
      received.push(message)
      if (message.method === 'initialize' && message.id !== undefined) {
        stdout.write(
          encodeLspMessage({
            jsonrpc: '2.0',
            id: message.id,
            result: { capabilities: serverCapabilities }
          })
        )
      }
    }
  })

  return {
    child,
    received,
    reply(id: number, result: unknown): void {
      stdout.write(encodeLspMessage({ jsonrpc: '2.0', id, result }))
    },
    notify(method: string, params: unknown): void {
      stdout.write(encodeLspMessage({ jsonrpc: '2.0', method, params }))
    },
    requestFromServer(id: number | string, method: string, params: unknown): void {
      stdout.write(encodeLspMessage({ jsonrpc: '2.0', id, method, params }))
    },
    async waitFor(predicate: (message: JsonRpcMessage) => boolean): Promise<JsonRpcMessage> {
      for (let attempt = 0; attempt < 200; attempt++) {
        const match = received.find(predicate)
        if (match) {
          return match
        }
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      throw new Error('fake server never received the expected message')
    }
  }
}

function createManagerWithFakeServer(serverCapabilities?: Record<string, unknown>) {
  const fake = createFakeServer(serverCapabilities)
  const spawnServer = vi.fn(() => fake.child)
  const manager = createLspSessionManager({
    spawnServer,
    probeCommand: () => Promise.resolve(true)
  })
  return { fake, manager, spawnServer }
}

const openArgs = {
  filePath: '/workspace/repo/src/index.ts',
  rootPath: '/workspace/repo',
  languageId: 'typescript',
  text: 'const x = 1'
}

describe('createLspSessionManager', () => {
  it('returns no session when no server matches the language', async () => {
    const { manager, spawnServer } = createManagerWithFakeServer()
    const result = await manager.openDocument({ ...openArgs, languageId: 'plaintext' })
    expect(result).toEqual({
      sessionId: null,
      fileUri: null,
      serverId: null,
      pullDiagnostics: false
    })
    expect(spawnServer).not.toHaveBeenCalled()
  })

  it('initializes once, sends didOpen, and reuses the session per root', async () => {
    const { fake, manager, spawnServer } = createManagerWithFakeServer()
    const first = await manager.openDocument(openArgs)
    const second = await manager.openDocument({
      ...openArgs,
      filePath: '/workspace/repo/src/other.ts'
    })
    expect(first.sessionId).toBe(second.sessionId)
    expect(first.fileUri).toBe(pathToFileURL(openArgs.filePath).toString())
    expect(first.serverId).toBe('tsgo')
    expect(first.pullDiagnostics).toBe(false)
    expect(spawnServer).toHaveBeenCalledTimes(1)
    await fake.waitFor((m) => m.method === 'initialized')
    const didOpens = fake.received.filter((m) => m.method === 'textDocument/didOpen')
    expect(didOpens).toHaveLength(2)
  })

  it('reports pullDiagnostics when the server advertises a diagnosticProvider', async () => {
    const { manager } = createManagerWithFakeServer({ diagnosticProvider: { identifier: 'ts' } })
    const opened = await manager.openDocument(openArgs)
    expect(opened.pullDiagnostics).toBe(true)
  })

  it('answers workspace/configuration with one null per requested item', async () => {
    const { fake, manager } = createManagerWithFakeServer()
    await manager.openDocument(openArgs)
    fake.requestFromServer('cfg-1', 'workspace/configuration', {
      items: [{ section: 'a' }, { section: 'b' }]
    })
    const reply = await fake.waitFor((m) => (m.id as unknown) === 'cfg-1' && m.method === undefined)
    expect(reply.result).toEqual([null, null])
  })

  it('routes requests and resolves with the server result', async () => {
    const { fake, manager } = createManagerWithFakeServer()
    const { sessionId } = await manager.openDocument(openArgs)
    const pending = manager.request(sessionId!, 'textDocument/hover', { position: {} })
    const hoverRequest = await fake.waitFor((m) => m.method === 'textDocument/hover')
    fake.reply(hoverRequest.id!, { contents: 'docs' })
    await expect(pending).resolves.toEqual({ contents: 'docs' })
  })

  it('forwards publishDiagnostics for open documents only', async () => {
    const { fake, manager } = createManagerWithFakeServer()
    const diagnostics = vi.fn()
    manager.onDiagnostics(diagnostics)
    const { sessionId, fileUri } = await manager.openDocument(openArgs)
    fake.notify('textDocument/publishDiagnostics', {
      uri: fileUri,
      diagnostics: [{ message: 'boom' }]
    })
    fake.notify('textDocument/publishDiagnostics', {
      uri: 'file:///workspace/repo/never-opened.ts',
      diagnostics: [{ message: 'ignored' }]
    })
    await vi.waitFor(() => expect(diagnostics).toHaveBeenCalledTimes(1))
    expect(diagnostics).toHaveBeenCalledWith({
      sessionId,
      fileUri,
      diagnostics: [{ message: 'boom' }]
    })
  })

  it('sends didChange with growing versions and didClose only at refcount zero', async () => {
    const { fake, manager } = createManagerWithFakeServer()
    const { sessionId, fileUri } = await manager.openDocument(openArgs)
    // Why: a repeat open re-syncs text (last writer wins), producing version 2.
    await manager.openDocument({ ...openArgs, text: 'const x = 1.5' })
    manager.changeDocument(sessionId!, fileUri!, 'const x = 2')
    manager.closeDocument(sessionId!, fileUri!)
    manager.changeDocument(sessionId!, fileUri!, 'const x = 3')
    manager.closeDocument(sessionId!, fileUri!)
    await fake.waitFor((m) => m.method === 'textDocument/didClose')
    const changes = fake.received.filter((m) => m.method === 'textDocument/didChange')
    expect(
      changes.map((m) => (m.params as { textDocument: { version: number } }).textDocument.version)
    ).toEqual([2, 3, 4])
    expect(fake.received.filter((m) => m.method === 'textDocument/didClose')).toHaveLength(1)
  })

  it('forwards publishDiagnostics whose URI encodes the path differently', async () => {
    const { fake, manager } = createManagerWithFakeServer()
    const diagnostics = vi.fn()
    manager.onDiagnostics(diagnostics)
    const { sessionId, fileUri } = await manager.openDocument(openArgs)
    // Why: vscode-uri-based servers percent-encode where pathToFileURL does not.
    fake.notify('textDocument/publishDiagnostics', {
      uri: fileUri!.replace('index.ts', 'index%2Ets'),
      diagnostics: [{ message: 'boom' }]
    })
    await vi.waitFor(() => expect(diagnostics).toHaveBeenCalledTimes(1))
    expect(diagnostics).toHaveBeenCalledWith({
      sessionId,
      fileUri,
      diagnostics: [{ message: 'boom' }]
    })
  })

  it('announces .tsx documents as typescriptreact in didOpen', async () => {
    const { fake, manager } = createManagerWithFakeServer()
    await manager.openDocument({ ...openArgs, filePath: '/workspace/repo/src/App.tsx' })
    const didOpen = await fake.waitFor((m) => m.method === 'textDocument/didOpen')
    expect(
      (didOpen.params as { textDocument: { languageId: string } }).textDocument.languageId
    ).toBe('typescriptreact')
  })

  it('rejects in-flight requests when the server exits', async () => {
    const { fake, manager } = createManagerWithFakeServer()
    const { sessionId } = await manager.openDocument(openArgs)
    const pending = manager.request(sessionId!, 'textDocument/definition', {})
    await fake.waitFor((m) => m.method === 'textDocument/definition')
    fake.child.emit('exit', 1)
    await expect(pending).rejects.toThrow('LSP server exited')
    await expect(manager.request(sessionId!, 'textDocument/hover', {})).rejects.toThrow(
      'Unknown LSP session'
    )
  })

  it('kills every child on disposeAll', async () => {
    const { fake, manager } = createManagerWithFakeServer()
    await manager.openDocument(openArgs)
    manager.disposeAll()
    expect(fake.child.kill).toHaveBeenCalled()
  })
})
