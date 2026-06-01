import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { RelayDispatcher } from './dispatcher'

const { resolveLanguageServerCommandMock } = vi.hoisted(() => ({
  resolveLanguageServerCommandMock: vi.fn()
}))

vi.mock('../main/lsp/language-server-registry', () => ({
  resolveLanguageServerCommand: resolveLanguageServerCommandMock
}))

import { LspHandler } from './lsp-handler'

const FAKE_RELAY_LSP_SERVER = String.raw`
const documents = new Map()
let buffer = Buffer.alloc(0)

function send(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  process.stdout.write('Content-Length: ' + body.length + '\r\n\r\n')
  process.stdout.write(body)
}

function handle(message) {
  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: { capabilities: { textDocumentSync: { openClose: true, change: 1 }, hoverProvider: true } }
    })
    return
  }
  if (message.method === 'textDocument/didOpen') {
    const doc = message.params.textDocument
    documents.set(doc.uri, doc.text)
    send({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: {
        uri: doc.uri,
        diagnostics: [{
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
          severity: 2,
          message: 'relay diagnostic'
        }]
      }
    })
    return
  }
  if (message.method === 'textDocument/hover') {
    send({ jsonrpc: '2.0', id: message.id, result: { contents: 'relay hover' } })
    return
  }
  if (message.method === 'shutdown') {
    send({ jsonrpc: '2.0', id: message.id, result: null })
    return
  }
  if (message.method === 'exit') {
    process.exit(0)
  }
  if (message.id !== undefined) {
    send({ jsonrpc: '2.0', id: message.id, result: null })
  }
}

process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk])
  while (true) {
    const headerEnd = buffer.indexOf('\r\n\r\n')
    if (headerEnd === -1) break
    const header = buffer.subarray(0, headerEnd).toString('utf8')
    const match = /Content-Length:\s*(\d+)/i.exec(header)
    if (!match) {
      buffer = buffer.subarray(headerEnd + 4)
      continue
    }
    const length = Number(match[1])
    const start = headerEnd + 4
    const end = start + length
    if (buffer.length < end) break
    const message = JSON.parse(buffer.subarray(start, end).toString('utf8'))
    buffer = buffer.subarray(end)
    handle(message)
  }
})
`

function createMockDispatcher() {
  const requestHandlers = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>()
  const notifications: { method: string; params?: Record<string, unknown> }[] = []
  return {
    onRequest: vi.fn(
      (method: string, handler: (params: Record<string, unknown>) => Promise<unknown>) => {
        requestHandlers.set(method, handler)
      }
    ),
    notify: vi.fn((method: string, params?: Record<string, unknown>) => {
      notifications.push({ method, params })
    }),
    async callRequest(method: string, params: Record<string, unknown> = {}) {
      const handler = requestHandlers.get(method)
      if (!handler) {
        throw new Error(`No handler for ${method}`)
      }
      return handler(params)
    },
    notifications
  }
}

async function waitForNotification(
  notifications: { method: string; params?: Record<string, unknown> }[],
  method: string
): Promise<Record<string, unknown>> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 2_000) {
    const match = notifications.find((item) => item.method === method)
    if (match?.params) {
      return match.params
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`Timed out waiting for ${method}`)
}

describe('LspHandler', () => {
  let dir: string
  let dispatcher: ReturnType<typeof createMockDispatcher>
  let handler: LspHandler | null = null

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-relay-lsp-'))
    dispatcher = createMockDispatcher()
    resolveLanguageServerCommandMock.mockReset()
  })

  afterEach(async () => {
    await handler?.dispose()
    handler = null
    rmSync(dir, { recursive: true, force: true })
  })

  it('registers relay LSP methods and hosts the server process remotely', async () => {
    const serverPath = join(dir, 'fake-relay-lsp.cjs')
    const filePath = join(dir, 'main.rs')
    writeFileSync(serverPath, FAKE_RELAY_LSP_SERVER)
    writeFileSync(filePath, 'fn main() {}')
    resolveLanguageServerCommandMock.mockResolvedValue({
      ok: true,
      command: { command: process.execPath, args: [serverPath] }
    })

    handler = new LspHandler(dispatcher as unknown as RelayDispatcher)

    await expect(
      dispatcher.callRequest('lsp.getStatus', { worktreePath: dir, languageId: 'rust' })
    ).resolves.toMatchObject({ state: 'available', languageId: 'rust' })

    await dispatcher.callRequest('lsp.openDocument', {
      worktreeId: 'repo::worktree',
      worktreePath: dir,
      filePath,
      languageId: 'rust',
      content: 'fn main() {}'
    })

    const diagnostic = await waitForNotification(dispatcher.notifications, 'lsp.diagnostics')
    expect(diagnostic).toMatchObject({
      worktreePath: dir,
      filePath,
      languageId: 'rust',
      diagnostics: [{ message: 'relay diagnostic' }]
    })

    await expect(
      dispatcher.callRequest('lsp.hover', {
        worktreeId: 'repo::worktree',
        worktreePath: dir,
        filePath,
        languageId: 'rust',
        content: 'fn main() {}',
        position: { line: 0, character: 1 }
      })
    ).resolves.toEqual({ contents: 'relay hover' })
  })

  it('does not start relay LSP sessions for runtime environments yet', async () => {
    const serverPath = join(dir, 'fake-relay-lsp.cjs')
    const filePath = join(dir, 'main.rs')
    writeFileSync(serverPath, FAKE_RELAY_LSP_SERVER)
    writeFileSync(filePath, 'fn main() {}')
    resolveLanguageServerCommandMock.mockResolvedValue({
      ok: true,
      command: { command: process.execPath, args: [serverPath] }
    })

    handler = new LspHandler(dispatcher as unknown as RelayDispatcher)

    await expect(
      dispatcher.callRequest('lsp.getStatus', {
        worktreePath: dir,
        languageId: 'rust',
        runtimeEnvironmentId: 'env-a'
      })
    ).resolves.toMatchObject({
      state: 'unavailable',
      reason: 'LSP is not available for runtime environments yet'
    })

    await expect(
      dispatcher.callRequest('lsp.openDocument', {
        worktreeId: 'repo::worktree',
        worktreePath: dir,
        filePath,
        languageId: 'rust',
        runtimeEnvironmentId: 'env-a',
        content: 'fn main() {}'
      })
    ).rejects.toThrow('LSP is not available for runtime environments yet')

    expect(handler.getStats().activeSessions).toBe(0)
  })
})
