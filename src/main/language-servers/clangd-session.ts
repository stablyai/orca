// clangd protocol session on top of the JSON-RPC client + native process
// adapter. The initialize shape, server-request answers and result mapping
// live in clangd-protocol.ts; this module owns lifecycle and the document
// table. Shutdown ladder per spec D8: shutdown -> exit -> grace -> tree kill.
import type { spawnProcess } from '../../shared/child-process/run-process'
import { createLspJsonRpcClient, type LspJsonRpcClient } from './lsp-jsonrpc-client'
import {
  openNativeLanguageServerProcess,
  NATIVE_LANGUAGE_SERVER_GRACEFUL_EXIT_MS,
  type NativeLanguageServerProcess
} from './native-language-server-process'
import {
  answerClangdServerRequest,
  buildClangdInitializeParams,
  createClangdProgressTracker,
  mapClangdDefinitionResult,
  mapClangdHoverResult
} from './clangd-protocol'
import { lspUriToNativePath, nativePathToLspUri, normalizeNativeFilePath } from './uri-mapping'
import type {
  LanguageServerDefinitionLocation,
  LanguageServerDocumentChange,
  LanguageServerHoverContent,
  LanguageServerPosition
} from '../../shared/language-server-navigation-types'

export class ClangdPositionEncodingError extends Error {
  constructor(actual: string | undefined) {
    super(
      `clangd did not confirm positionEncoding utf-16 (got ${actual ?? 'none'}); refusing the session — column math would corrupt on non-ASCII lines`
    )
    this.name = 'ClangdPositionEncodingError'
  }
}

export class ClangdDocumentNotOpenError extends Error {
  constructor(filePath: string) {
    super(`clangd session has no open document: ${filePath}`)
    this.name = 'ClangdDocumentNotOpenError'
  }
}

const INITIALIZE_TIMEOUT_MS = 15_000
const SHUTDOWN_TIMEOUT_MS = 5_000

export type ClangdSessionOptions = {
  program: string
  args: readonly string[]
  /** Worktree root in native path form; session cwd + rootUri. */
  rootPath: string
  /** `$/progress` projection for the status line; null clears it. */
  onStatus?: (text: string | null) => void
  onLog?: (line: string) => void
  /** Fired once when the session ends for any reason (crash or stop). */
  onExit?: (error: Error | null) => void
  spawnImpl?: typeof spawnProcess
}

export type ClangdSession = {
  readonly serverVersion: string | null
  readonly rootPath: string
  readonly died: Error | null
  hasDocument(filePath: string): boolean
  didOpen(filePath: string, text: string): void
  /** Returns the version actually sent after the monotonic clamp. */
  didChange(
    filePath: string,
    version: number,
    changes: readonly LanguageServerDocumentChange[]
  ): number
  didClose(filePath: string): void
  definition(
    filePath: string,
    position: LanguageServerPosition
  ): Promise<LanguageServerDefinitionLocation[]>
  hover(
    filePath: string,
    position: LanguageServerPosition
  ): Promise<LanguageServerHoverContent | null>
  /** shutdown -> exit -> 5s grace -> tree kill (spec D8). */
  stop(): Promise<void>
}

type OpenDocument = {
  uri: string
  version: number
}

const LSP_LANGUAGE_BY_EXTENSION: Record<string, string> = {
  '.c': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.c++': 'cpp',
  '.hpp': 'cpp',
  '.hh': 'cpp',
  '.h': 'cpp',
  '.hxx': 'cpp',
  '.inl': 'cpp',
  '.m': 'objective-c',
  '.mm': 'objective-cpp'
}

function lspLanguageForFile(filePath: string): string {
  const dot = filePath.lastIndexOf('.')
  if (dot === -1) {
    return 'cpp'
  }
  return LSP_LANGUAGE_BY_EXTENSION[filePath.slice(dot).toLowerCase()] ?? 'cpp'
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Spawns clangd, runs the initialize handshake, and returns a session bound to
 * the process. Rejects — after reaping the child — when the handshake fails or
 * the server does not confirm `positionEncoding: utf-16`.
 */
export async function openClangdSession(options: ClangdSessionOptions): Promise<ClangdSession> {
  const log = (line: string): void => options.onLog?.(line)
  const progress = createClangdProgressTracker()

  let client: LspJsonRpcClient | null = null
  let stopping = false
  let died: Error | null = null
  let serverVersion: string | null = null

  const documents = new Map<string, OpenDocument>()

  const markDied = (reason: string): void => {
    if (died !== null) {
      return
    }
    died = new Error(`clangd session died: ${reason}`)
    client?.die(reason)
    options.onStatus?.(null)
    options.onExit?.(died)
  }

  const processHandle: NativeLanguageServerProcess = openNativeLanguageServerProcess(
    { program: options.program, args: options.args, cwd: options.rootPath },
    {
      onStdoutChunk: (chunk) => client?.feed(chunk),
      onStderrLine: (line) => log(`[clangd] ${line}`),
      onExit: (error) => {
        if (stopping) {
          options.onExit?.(null)
          return
        }
        markDied(error ? `process exit: ${error.message}` : 'process exited unexpectedly')
      }
    },
    options.spawnImpl
  )

  client = createLspJsonRpcClient((bytes) => processHandle.write(bytes), {
    onServerNotification: handleNotification,
    onServerRequest: (method, params) => answerClangdServerRequest(method, params, log),
    onProtocolError: (error) => {
      log(`[clangd] protocol error: ${error.message}`)
      markDied(`protocol error: ${error.message}`)
      void processHandle.killTree()
    }
  })

  function handleNotification(method: string, params: unknown): void {
    if (method === '$/progress') {
      const status = progress.reduce(params)
      if (status !== undefined) {
        options.onStatus?.(status)
      }
      return
    }
    if (method === 'textDocument/publishDiagnostics') {
      // v1 keeps diagnostics only for version alignment — no IPC, no UI (spec §1).
      const p = params as { uri?: string; version?: number | null } | null
      if (p?.uri && typeof p.version === 'number') {
        const doc = documents.get(lspUriToNativePath(p.uri))
        if (doc) {
          doc.version = Math.max(doc.version, p.version)
        }
      }
      return
    }
    if (method === 'window/logMessage') {
      log(`[clangd/log] ${(params as { message?: string } | null)?.message ?? ''}`)
      return
    }
    if (method === 'exit' || method.startsWith('$/')) {
      return // LSP: $/ notifications may be dropped silently.
    }
    log(`[clangd] notification ${method}`)
  }

  async function handshake(): Promise<void> {
    const result = (await client!.request(
      'initialize',
      buildClangdInitializeParams(options.rootPath, process.pid),
      { timeoutMs: INITIALIZE_TIMEOUT_MS }
    )) as { capabilities?: { positionEncoding?: string }; serverInfo?: { version?: string } } | null

    const encoding = result?.capabilities?.positionEncoding
    if (encoding !== 'utf-16') {
      throw new ClangdPositionEncodingError(encoding)
    }
    serverVersion = result?.serverInfo?.version ?? null
    client!.notify('initialized', {})
  }

  function documentFor(filePath: string): OpenDocument {
    const key = normalizeNativeFilePath(filePath)
    const doc = documents.get(key)
    if (!doc) {
      throw new ClangdDocumentNotOpenError(key)
    }
    return doc
  }

  function positionParams(filePath: string, position: LanguageServerPosition): unknown {
    return {
      textDocument: { uri: documentFor(filePath).uri },
      position: { line: position.line, character: position.character }
    }
  }

  const session: ClangdSession = {
    get serverVersion(): string | null {
      return serverVersion
    },
    get rootPath(): string {
      return options.rootPath
    },
    get died(): Error | null {
      return died
    },
    hasDocument(filePath: string): boolean {
      return documents.has(normalizeNativeFilePath(filePath))
    },
    didOpen(filePath: string, text: string): void {
      const key = normalizeNativeFilePath(filePath)
      const uri = nativePathToLspUri(key)
      documents.set(key, { uri, version: 1 })
      client?.notify('textDocument/didOpen', {
        textDocument: { uri, languageId: lspLanguageForFile(key), version: 1, text }
      })
    },
    didChange(
      filePath: string,
      version: number,
      changes: readonly LanguageServerDocumentChange[]
    ): number {
      const doc = documentFor(filePath)
      // LSP requires monotonically increasing versions; the renderer owns the
      // counter, the session clamps replays and out-of-order IPC (spec D4).
      doc.version = Math.max(doc.version + 1, version)
      client?.notify('textDocument/didChange', {
        textDocument: { uri: doc.uri, version: doc.version },
        contentChanges: changes.map((change) => ({
          range: {
            start: { line: change.range.startLine, character: change.range.startCharacter },
            end: { line: change.range.endLine, character: change.range.endCharacter }
          },
          rangeLength: change.rangeLength,
          text: change.text
        }))
      })
      return doc.version
    },
    didClose(filePath: string): void {
      const key = normalizeNativeFilePath(filePath)
      const doc = documentFor(filePath)
      documents.delete(key)
      client?.notify('textDocument/didClose', { textDocument: { uri: doc.uri } })
    },
    async definition(
      filePath: string,
      position: LanguageServerPosition
    ): Promise<LanguageServerDefinitionLocation[]> {
      const result = await client!.request(
        'textDocument/definition',
        positionParams(filePath, position)
      )
      return mapClangdDefinitionResult(result, lspUriToNativePath)
    },
    async hover(
      filePath: string,
      position: LanguageServerPosition
    ): Promise<LanguageServerHoverContent | null> {
      const result = await client!.request('textDocument/hover', positionParams(filePath, position))
      return mapClangdHoverResult(result)
    },
    async stop(): Promise<void> {
      if (died !== null || stopping) {
        return
      }
      stopping = true
      try {
        await Promise.race([
          client!.request('shutdown', null, { timeoutMs: SHUTDOWN_TIMEOUT_MS }),
          sleep(SHUTDOWN_TIMEOUT_MS)
        ])
      } catch {
        // Fall through to the exit ladder — a deaf clangd still gets killed.
      }
      client!.notify('exit')
      processHandle.endStdin()
      const exitedFirst = await Promise.race([
        processHandle.exited.then(() => true),
        sleep(NATIVE_LANGUAGE_SERVER_GRACEFUL_EXIT_MS).then(() => false)
      ])
      if (!exitedFirst) {
        await processHandle.killTree()
      }
    }
  }

  try {
    await handshake()
  } catch (error) {
    await session.stop()
    throw error instanceof Error ? error : new Error(String(error))
  }
  return session
}
