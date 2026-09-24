// clangd protocol session on top of the JSON-RPC client + native process
// adapter. The initialize shape, server-request answers and result mapping
// live in clangd-protocol.ts; this module owns lifecycle and the document
// table. Shutdown ladder per spec D8: shutdown -> exit -> grace -> tree kill.
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
  mapClangdHoverResult,
  mapClangdLocationResult
} from './clangd-protocol'
import { lspUriToNativePath, nativePathToLspUri, normalizeNativeFilePath } from './uri-mapping'
import type { ClangdSession, ClangdSessionOptions } from './clangd-session-types'
export type { ClangdSession, ClangdSessionOptions } from './clangd-session-types'
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
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: publishDiagnostics params are the wire-deserialized LSP payload; `uri`/`version` are read through optional chaining and typeof-checked before use.
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
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: logMessage params are the wire-deserialized LSP payload; `message` is read through optional chaining for the log line.
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
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the initialize result is the wire-deserialized LSP InitializeResult; `positionEncoding` is verified against utf-16 (throws otherwise), `referencesProvider`/`declarationProvider` are checked for presence (warned if absent), and `serverInfo.version` is read through optional chaining.
    )) as {
      capabilities?: {
        positionEncoding?: string
        referencesProvider?: unknown
        declarationProvider?: unknown
      }
      serverInfo?: { version?: string }
    } | null

    const encoding = result?.capabilities?.positionEncoding
    if (encoding !== 'utf-16') {
      throw new ClangdPositionEncodingError(encoding)
    }
    // Verify the server echoes the S4 capabilities (S4 criterion). clangd
    // always advertises both; absence means a non-conformant build — warn so
    // the request's failure is explainable, but don't refuse (the request
    // itself is the authoritative check; spec §9 residual risk).
    const caps = result?.capabilities
    if (caps && (!caps.referencesProvider || !caps.declarationProvider)) {
      log('[clangd] server did not advertise references/declaration capability')
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

  function positionParams(
    filePath: string,
    position: LanguageServerPosition
  ): {
    textDocument: { uri: string }
    position: { line: number; character: number }
  } {
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
    async references(
      filePath: string,
      position: LanguageServerPosition
    ): Promise<LanguageServerDefinitionLocation[]> {
      // `includeDeclaration: true` so the declaration site appears in the list
      // (matches VS Code's Shift+F12 default; clangd honors the field).
      const params = {
        ...positionParams(filePath, position),
        context: { includeDeclaration: true }
      }
      const result = await client!.request('textDocument/references', params)
      return mapClangdLocationResult(result, lspUriToNativePath)
    },
    async declaration(
      filePath: string,
      position: LanguageServerPosition
    ): Promise<LanguageServerDefinitionLocation[]> {
      const result = await client!.request(
        'textDocument/declaration',
        positionParams(filePath, position)
      )
      return mapClangdLocationResult(result, lspUriToNativePath)
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
