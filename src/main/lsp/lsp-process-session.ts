/* eslint-disable max-lines -- Why: this file owns the complete stdio LSP JSON-RPC
client state machine (framing, lifecycle, document sync, and request routing);
splitting those pieces would make protocol ordering harder to audit. */
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { fileURLToPath, pathToFileURL } from 'url'
import type {
  LspCompletionResult,
  LspDiagnostic,
  LspHover,
  LspLocation,
  LspPosition
} from '../../shared/lsp-types'
import { getSpawnArgsForWindows } from '../win32-utils'
import type { LanguageServerCommand } from './language-server-registry'

type JsonRpcRequest = {
  jsonrpc: '2.0'
  id: number
  method: string
  params?: unknown
}

type JsonRpcNotification = {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

type JsonRpcResponse = {
  jsonrpc: '2.0'
  id: number
  result?: unknown
  error?: { code: number; message: string }
}

type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

type OpenDocument = {
  filePath: string
  languageId: string
  text: string
  version: number
}

type TextDocumentSyncKind = 0 | 1 | 2

export type LspProcessSessionOptions = {
  rootPath: string
  languageId: string
  server: LanguageServerCommand
  connectionId?: string
  onDiagnostics?: (event: {
    filePath: string
    languageId: string
    diagnostics: LspDiagnostic[]
  }) => void
}

export type LspProcessStats = {
  startedAt: number
  initializedAt: number
  requestCount: number
  notificationCount: number
  openDocumentCount: number
}

const DEFAULT_REQUEST_TIMEOUT_MS = 8_000
const SHUTDOWN_REQUEST_TIMEOUT_MS = 1_500
const DISPOSE_EXIT_TIMEOUT_MS = 500
const DISPOSE_KILL_TIMEOUT_MS = 500

function lspPathToUri(filePath: string): string {
  return pathToFileURL(filePath).toString()
}

function lspUriToPath(uri: string): string {
  const parsed = new URL(uri)
  const isWindowsFileUri =
    process.platform === 'win32' || parsed.hostname !== '' || /^\/[A-Za-z]:/.test(parsed.pathname)
  return fileURLToPath(uri, { windows: isWindowsFileUri })
}

function endPosition(text: string): LspPosition {
  const lines = text.split(/\r\n|\r|\n/)
  return {
    line: lines.length - 1,
    character: lines.at(-1)?.length ?? 0
  }
}

function extractTextDocumentSyncKind(capabilities: Record<string, unknown>): TextDocumentSyncKind {
  const sync = capabilities.textDocumentSync
  if (typeof sync === 'number') {
    return sync === 2 ? 2 : sync === 1 ? 1 : 0
  }
  if (sync && typeof sync === 'object') {
    const change = (sync as { change?: unknown }).change
    return change === 2 ? 2 : change === 1 ? 1 : 0
  }
  return 1
}

function parseContentLength(header: string): number | null {
  const match = /(?:^|\r\n)Content-Length:\s*(\d+)/i.exec(header)
  if (!match) {
    return null
  }
  const length = Number(match[1])
  return Number.isFinite(length) && length >= 0 ? length : null
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

export class LspProcessSession {
  private readonly rootPath: string
  private readonly languageId: string
  private readonly server: LanguageServerCommand
  private readonly onDiagnostics?: LspProcessSessionOptions['onDiagnostics']
  private child: ChildProcessWithoutNullStreams | null = null
  private buffer = Buffer.alloc(0)
  private nextRequestId = 1
  private pending = new Map<number, PendingRequest>()
  private documents = new Map<string, OpenDocument>()
  private initializePromise: Promise<void> | null = null
  private textDocumentSyncKind: TextDocumentSyncKind = 1
  private disposed = false
  private stats: LspProcessStats = {
    startedAt: 0,
    initializedAt: 0,
    requestCount: 0,
    notificationCount: 0,
    openDocumentCount: 0
  }

  constructor(options: LspProcessSessionOptions) {
    this.rootPath = options.rootPath
    this.languageId = options.languageId
    this.server = options.server
    this.onDiagnostics = options.onDiagnostics
  }

  getStats(): LspProcessStats {
    return {
      ...this.stats,
      openDocumentCount: this.documents.size
    }
  }

  getOpenDocumentCount(): number {
    return this.documents.size
  }

  async openDocument(filePath: string, languageId: string, text: string): Promise<void> {
    await this.ensureInitialized()
    const uri = lspPathToUri(filePath)
    const existing = this.documents.get(uri)
    if (existing) {
      await this.changeDocument(filePath, text)
      return
    }
    this.documents.set(uri, { filePath, languageId, text, version: 1 })
    this.notify('textDocument/didOpen', {
      textDocument: {
        uri,
        languageId,
        version: 1,
        text
      }
    })
  }

  async changeDocument(filePath: string, text: string): Promise<void> {
    await this.ensureInitialized()
    const uri = lspPathToUri(filePath)
    const existing = this.documents.get(uri)
    if (!existing) {
      await this.openDocument(filePath, this.languageId, text)
      return
    }
    if (existing.text === text) {
      return
    }
    const nextVersion = existing.version + 1
    const previousText = existing.text
    existing.text = text
    existing.version = nextVersion
    const contentChanges =
      this.textDocumentSyncKind === 2
        ? [
            {
              range: {
                start: { line: 0, character: 0 },
                end: endPosition(previousText)
              },
              text
            }
          ]
        : [{ text }]
    this.notify('textDocument/didChange', {
      textDocument: { uri, version: nextVersion },
      contentChanges
    })
  }

  async closeDocument(filePath: string): Promise<void> {
    if (!this.initializePromise) {
      return
    }
    await this.ensureInitialized().catch(() => undefined)
    const uri = lspPathToUri(filePath)
    if (!this.documents.has(uri)) {
      return
    }
    this.documents.delete(uri)
    this.notify('textDocument/didClose', {
      textDocument: { uri }
    })
  }

  async completion(
    filePath: string,
    position: LspPosition,
    text?: string
  ): Promise<LspCompletionResult | null> {
    await (text !== undefined ? this.changeDocument(filePath, text) : this.ensureInitialized())
    return (await this.request(
      'textDocument/completion',
      {
        textDocument: { uri: lspPathToUri(filePath) },
        position
      },
      DEFAULT_REQUEST_TIMEOUT_MS
    )) as LspCompletionResult | null
  }

  async hover(filePath: string, position: LspPosition, text?: string): Promise<LspHover | null> {
    await (text !== undefined ? this.changeDocument(filePath, text) : this.ensureInitialized())
    return (await this.request(
      'textDocument/hover',
      {
        textDocument: { uri: lspPathToUri(filePath) },
        position
      },
      DEFAULT_REQUEST_TIMEOUT_MS
    )) as LspHover | null
  }

  async definition(filePath: string, position: LspPosition, text?: string): Promise<LspLocation[]> {
    await (text !== undefined ? this.changeDocument(filePath, text) : this.ensureInitialized())
    const result = await this.request(
      'textDocument/definition',
      {
        textDocument: { uri: lspPathToUri(filePath) },
        position
      },
      DEFAULT_REQUEST_TIMEOUT_MS
    )
    if (!result) {
      return []
    }
    if (Array.isArray(result)) {
      return result.flatMap((item) => this.normalizeLocation(item))
    }
    return this.normalizeLocation(result)
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('LSP session disposed'))
    }
    this.pending.clear()
    const child = this.child
    if (!child) {
      this.disposed = true
      return
    }
    try {
      await this.request('shutdown', null, SHUTDOWN_REQUEST_TIMEOUT_MS)
      this.notify('exit')
    } catch {
      // Shutdown is best-effort; a timed-out server still needs process cleanup.
    } finally {
      this.disposed = true
    }
    if (await this.waitForExit(child, DISPOSE_EXIT_TIMEOUT_MS)) {
      return
    }
    child.kill()
    if (await this.waitForExit(child, DISPOSE_KILL_TIMEOUT_MS)) {
      return
    }
    child.kill('SIGKILL')
    await this.waitForExit(child, DISPOSE_KILL_TIMEOUT_MS)
  }

  private normalizeLocation(value: unknown): LspLocation[] {
    if (!value || typeof value !== 'object') {
      return []
    }
    if ('targetUri' in value) {
      const link = value as {
        targetUri?: string
        targetSelectionRange?: LspLocation['range']
        targetRange?: LspLocation['range']
      }
      if (!link.targetUri || (!link.targetSelectionRange && !link.targetRange)) {
        return []
      }
      return [
        {
          uri: link.targetUri,
          range: link.targetSelectionRange ?? link.targetRange!
        }
      ]
    }
    const location = value as Partial<LspLocation>
    if (!location.uri || !location.range) {
      return []
    }
    return [{ uri: location.uri, range: location.range }]
  }

  private ensureInitialized(): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new Error('LSP session is not running'))
    }
    if (this.initializePromise) {
      return this.initializePromise
    }
    this.initializePromise = this.start()
    return this.initializePromise
  }

  private async start(): Promise<void> {
    this.stats.startedAt = Date.now()
    const { spawnCmd, spawnArgs } = getSpawnArgsForWindows(this.server.command, this.server.args)
    const child = spawn(spawnCmd, spawnArgs, {
      cwd: this.rootPath,
      stdio: 'pipe',
      env: process.env
    })
    this.child = child

    child.stdout.on('data', (chunk: Buffer) => this.handleData(chunk))
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8').trim()
      if (text) {
        console.debug(`[lsp:${this.languageId}] ${text}`)
      }
    })
    child.on('error', (error) => this.failSession(error))
    child.stdin.on('error', (error) => this.failSession(error))
    child.on('exit', () => {
      this.failSession(new Error(`${this.server.command} exited`))
    })

    const result = (await this.request(
      'initialize',
      {
        processId: process.pid,
        rootUri: lspPathToUri(this.rootPath),
        workspaceFolders: [
          {
            uri: lspPathToUri(this.rootPath),
            name: this.rootPath.split(/[\\/]/).pop() || this.rootPath
          }
        ],
        capabilities: {
          textDocument: {
            synchronization: {
              didSave: true,
              dynamicRegistration: false
            },
            completion: {
              completionItem: {
                snippetSupport: true,
                documentationFormat: ['markdown', 'plaintext']
              }
            },
            hover: {
              contentFormat: ['markdown', 'plaintext']
            },
            definition: {
              linkSupport: true
            },
            publishDiagnostics: {
              relatedInformation: false
            }
          },
          workspace: {
            workspaceFolders: true,
            configuration: true
          }
        }
      },
      10_000
    )) as { capabilities?: Record<string, unknown> } | null

    this.textDocumentSyncKind = extractTextDocumentSyncKind(result?.capabilities ?? {})
    this.notify('initialized', {})
    this.stats.initializedAt = Date.now()
  }

  private request(
    method: string,
    params?: unknown,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS
  ): Promise<unknown> {
    if (!this.child || this.disposed) {
      return Promise.reject(new Error('LSP session is not running'))
    }
    const id = this.nextRequestId++
    const message: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      ...(params !== undefined ? { params } : {})
    }
    this.stats.requestCount++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`LSP request timed out: ${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.writeMessage(message)
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(toError(error))
      }
    })
  }

  private notify(method: string, params?: unknown): void {
    if (!this.child || this.disposed) {
      return
    }
    this.stats.notificationCount++
    this.writeMessage({
      jsonrpc: '2.0',
      method,
      ...(params !== undefined ? { params } : {})
    })
  }

  private respond(id: number, result: unknown): void {
    this.writeMessage({ jsonrpc: '2.0', id, result } as JsonRpcResponse)
  }

  private writeMessage(message: JsonRpcMessage): void {
    const child = this.child
    if (!child || this.disposed || child.stdin.destroyed || !child.stdin.writable) {
      throw new Error('LSP session is not running')
    }
    const body = Buffer.from(JSON.stringify(message), 'utf-8')
    const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'utf-8')
    child.stdin.write(Buffer.concat([header, body]))
  }

  private failSession(error: Error): void {
    this.child = null
    this.disposed = true
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  private waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
    if (child.exitCode !== null || child.signalCode !== null) {
      return Promise.resolve(true)
    }
    return new Promise((resolve) => {
      const onExit = (): void => {
        clearTimeout(timer)
        resolve(true)
      }
      const timer = setTimeout(() => {
        child.off('exit', onExit)
        resolve(false)
      }, timeoutMs)
      timer.unref?.()
      child.once('exit', onExit)
    })
  }

  private handleData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n')
      if (headerEnd === -1) {
        return
      }
      const header = this.buffer.subarray(0, headerEnd).toString('utf-8')
      const contentLength = parseContentLength(header)
      if (contentLength === null) {
        this.buffer = this.buffer.subarray(headerEnd + 4)
        continue
      }
      const messageStart = headerEnd + 4
      const messageEnd = messageStart + contentLength
      if (this.buffer.length < messageEnd) {
        return
      }
      const raw = this.buffer.subarray(messageStart, messageEnd).toString('utf-8')
      this.buffer = this.buffer.subarray(messageEnd)
      try {
        this.handleMessage(JSON.parse(raw) as JsonRpcMessage)
      } catch (error) {
        console.warn('[lsp] failed to parse server message', error)
      }
    }
  }

  private handleMessage(message: JsonRpcMessage): void {
    if ('id' in message && !('method' in message)) {
      const pending = this.pending.get(message.id)
      if (!pending) {
        return
      }
      clearTimeout(pending.timer)
      this.pending.delete(message.id)
      if (message.error) {
        pending.reject(new Error(message.error.message))
      } else {
        pending.resolve(message.result ?? null)
      }
      return
    }

    if ('id' in message && 'method' in message) {
      this.handleServerRequest(message)
      return
    }

    if ('method' in message) {
      this.handleNotification(message)
    }
  }

  private handleServerRequest(message: JsonRpcRequest): void {
    if (message.method === 'workspace/configuration') {
      const params = message.params as { items?: unknown[] } | undefined
      this.respond(
        message.id,
        (params?.items ?? []).map(() => null)
      )
      return
    }
    if (message.method === 'workspace/applyEdit') {
      this.respond(message.id, { applied: false })
      return
    }
    this.respond(message.id, null)
  }

  private handleNotification(message: JsonRpcNotification): void {
    if (message.method !== 'textDocument/publishDiagnostics') {
      return
    }
    const params = message.params as
      | {
          uri?: string
          diagnostics?: LspDiagnostic[]
        }
      | undefined
    if (!params?.uri) {
      return
    }
    const filePath = lspUriToPath(params.uri)
    this.onDiagnostics?.({
      filePath,
      languageId: this.languageId,
      diagnostics: params.diagnostics ?? []
    })
  }
}
