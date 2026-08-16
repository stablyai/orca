import { pathToFileURL } from 'node:url'
import type { LspOpenDocumentResult, LspRequestMethod } from '../../shared/lsp-types'
import { canonicalFileUriKey } from './lsp-file-uri-key'
import { buildLspInitializeParams } from './lsp-initialize-params'
import { encodeLspMessage, LspMessageDecoder } from './lsp-message-framing'
import { resolveLspServerForLanguage, toLspDocumentLanguageId } from './lsp-server-catalog'
import type { LspServerDescriptor } from './lsp-server-catalog'
import { spawnLspServer } from './lsp-server-spawn'
import type { SpawnLspServer } from './lsp-server-spawn'
import type { LspDiagnosticsListener, LspSession, OpenDocumentState } from './lsp-session-state'

export type { LspDiagnosticsListener } from './lsp-session-state'

const MAX_CONCURRENT_SESSIONS = 6
const REQUEST_TIMEOUT_MS = 15_000
// Why: keep a doc-less server briefly for tab switches, but don't hold
// memory-heavy servers (tsserver, rust-analyzer) open indefinitely.
const IDLE_SHUTDOWN_MS = 3 * 60_000

export type LspSessionManager = ReturnType<typeof createLspSessionManager>

export function createLspSessionManager(deps?: {
  spawnServer?: SpawnLspServer
  probeCommand?: (command: string) => Promise<boolean>
}) {
  const sessionsByKey = new Map<string, LspSession>()
  const sessionsById = new Map<string, LspSession>()
  const diagnosticsListeners = new Set<LspDiagnosticsListener>()
  let nextSessionNumber = 1

  function send(session: LspSession, message: unknown): void {
    if (!session.disposed) {
      session.child.stdin.write(encodeLspMessage(message))
    }
  }

  function sendRequest(session: LspSession, method: string, params: unknown): Promise<unknown> {
    if (session.disposed) {
      return Promise.reject(new Error('LSP session is closed'))
    }
    const id = session.nextRequestId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        session.pending.delete(id)
        reject(new Error(`LSP request timed out: ${method}`))
      }, REQUEST_TIMEOUT_MS)
      session.pending.set(id, { resolve, reject, timer })
      send(session, { jsonrpc: '2.0', id, method, params })
    })
  }

  function handleServerMessage(session: LspSession, message: unknown): void {
    const parsed = message as {
      id?: number | string
      method?: string
      result?: unknown
      error?: { message?: string }
      params?: { uri?: string; diagnostics?: unknown[] }
    }
    if (parsed.id !== undefined && parsed.method === undefined) {
      const pending = session.pending.get(Number(parsed.id))
      if (!pending) {
        return
      }
      session.pending.delete(Number(parsed.id))
      clearTimeout(pending.timer)
      if (parsed.error) {
        pending.reject(new Error(parsed.error.message ?? 'LSP request failed'))
      } else {
        pending.resolve(parsed.result ?? null)
      }
      return
    }
    if (parsed.method === 'textDocument/publishDiagnostics' && parsed.params?.uri) {
      // Why: servers may publish for files the editor never opened (project-wide
      // scans); forwarding only open docs keeps renderer marker state bounded.
      // Match on the canonical key — servers mint their own URI form.
      const document = session.documentsByUri.get(canonicalFileUriKey(parsed.params.uri))
      if (!document) {
        return
      }
      for (const listener of diagnosticsListeners) {
        listener({
          sessionId: session.sessionId,
          fileUri: document.fileUri,
          diagnostics: parsed.params.diagnostics ?? []
        })
      }
      return
    }
    if (parsed.id !== undefined && parsed.method !== undefined) {
      // Why: answer server→client requests so servers that await them don't
      // stall. workspace/configuration expects one entry per requested item
      // (pyright hangs on a bare null); everything else accepts null.
      const configurationItems = (parsed.params as { items?: unknown[] } | undefined)?.items
      const result =
        parsed.method === 'workspace/configuration' && Array.isArray(configurationItems)
          ? configurationItems.map(() => null)
          : null
      send(session, { jsonrpc: '2.0', id: parsed.id, result })
    }
  }

  function disposeSession(session: LspSession, error?: Error): void {
    if (session.disposed) {
      return
    }
    session.disposed = true
    if (session.idleTimer) {
      clearTimeout(session.idleTimer)
      session.idleTimer = null
    }
    for (const pending of session.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error ?? new Error('LSP session closed'))
    }
    session.pending.clear()
    session.documentsByUri.clear()
    sessionsByKey.delete(session.key)
    sessionsById.delete(session.sessionId)
    session.child.kill()
  }

  function scheduleIdleShutdown(session: LspSession): void {
    if (session.idleTimer) {
      clearTimeout(session.idleTimer)
    }
    session.idleTimer = setTimeout(() => {
      if (session.documentsByUri.size === 0) {
        send(session, { jsonrpc: '2.0', method: 'exit' })
        disposeSession(session)
      }
    }, IDLE_SHUTDOWN_MS)
  }

  function createSession(
    descriptor: LspServerDescriptor,
    rootPath: string,
    key: string
  ): LspSession {
    const child = (deps?.spawnServer ?? spawnLspServer)(descriptor, rootPath)
    const session: LspSession = {
      sessionId: `lsp-${nextSessionNumber++}`,
      key,
      serverId: descriptor.serverId,
      child,
      nextRequestId: 1,
      pending: new Map(),
      documentsByUri: new Map(),
      initialization: Promise.resolve(),
      pullDiagnostics: false,
      idleTimer: null,
      disposed: false
    }
    const decoder = new LspMessageDecoder()
    child.stdout.on('data', (chunk: Buffer) => {
      for (const message of decoder.push(chunk)) {
        handleServerMessage(session, message)
      }
    })
    child.on('error', (error) => disposeSession(session, error))
    child.on('exit', () => disposeSession(session, new Error('LSP server exited')))
    child.stdin.on('error', () => disposeSession(session, new Error('LSP server pipe closed')))

    session.initialization = sendRequest(
      session,
      'initialize',
      buildLspInitializeParams(rootPath)
    ).then((result) => {
      const capabilities = (result as { capabilities?: { diagnosticProvider?: unknown } } | null)
        ?.capabilities
      session.pullDiagnostics = Boolean(capabilities?.diagnosticProvider)
      send(session, { jsonrpc: '2.0', method: 'initialized', params: {} })
    })
    // Why: a failed handshake must not surface as an unhandled rejection; open
    // callers await initialization and observe the failure there.
    session.initialization.catch(() => {})
    return session
  }

  const noSession: LspOpenDocumentResult = {
    sessionId: null,
    fileUri: null,
    serverId: null,
    pullDiagnostics: false
  }

  async function openDocument(args: {
    filePath: string
    rootPath: string
    languageId: string
    text: string
  }): Promise<LspOpenDocumentResult> {
    const descriptor = await resolveLspServerForLanguage(args.languageId, deps?.probeCommand)
    if (!descriptor) {
      return noSession
    }
    const key = `${descriptor.serverId} ${args.rootPath}`
    let session = sessionsByKey.get(key)
    if (!session || session.disposed) {
      if (sessionsByKey.size >= MAX_CONCURRENT_SESSIONS) {
        return noSession
      }
      session = createSession(descriptor, args.rootPath, key)
      sessionsByKey.set(key, session)
      sessionsById.set(session.sessionId, session)
    }
    try {
      await session.initialization
    } catch {
      disposeSession(session)
      return noSession
    }
    if (session.disposed) {
      return noSession
    }
    if (session.idleTimer) {
      clearTimeout(session.idleTimer)
      session.idleTimer = null
    }
    const fileUri = pathToFileURL(args.filePath).toString()
    const documentKey = canonicalFileUriKey(fileUri)
    const existing = session.documentsByUri.get(documentKey)
    if (existing) {
      existing.refCount++
      // Why: a second surface (diff pane vs editor tab) can open the same file
      // with different text; last writer wins so the server tracks what's shown.
      sendDidChange(session, existing.fileUri, existing, args.text)
    } else {
      session.documentsByUri.set(documentKey, { fileUri, version: 1, refCount: 1 })
      send(session, {
        jsonrpc: '2.0',
        method: 'textDocument/didOpen',
        params: {
          textDocument: {
            uri: fileUri,
            languageId: toLspDocumentLanguageId(args.languageId, args.filePath),
            version: 1,
            text: args.text
          }
        }
      })
    }
    return {
      sessionId: session.sessionId,
      fileUri,
      serverId: session.serverId,
      pullDiagnostics: session.pullDiagnostics
    }
  }

  function sendDidChange(
    session: LspSession,
    fileUri: string,
    document: OpenDocumentState,
    text: string
  ): void {
    document.version++
    send(session, {
      jsonrpc: '2.0',
      method: 'textDocument/didChange',
      params: {
        textDocument: { uri: fileUri, version: document.version },
        contentChanges: [{ text }]
      }
    })
  }

  function changeDocument(sessionId: string, fileUri: string, text: string): void {
    const session = sessionsById.get(sessionId)
    const document = session?.documentsByUri.get(canonicalFileUriKey(fileUri))
    if (!session || !document) {
      return
    }
    sendDidChange(session, document.fileUri, document, text)
  }

  function closeDocument(sessionId: string, fileUri: string): void {
    const session = sessionsById.get(sessionId)
    const documentKey = canonicalFileUriKey(fileUri)
    const document = session?.documentsByUri.get(documentKey)
    if (!session || !document) {
      return
    }
    document.refCount--
    if (document.refCount > 0) {
      return
    }
    session.documentsByUri.delete(documentKey)
    send(session, {
      jsonrpc: '2.0',
      method: 'textDocument/didClose',
      params: { textDocument: { uri: document.fileUri } }
    })
    if (session.documentsByUri.size === 0) {
      scheduleIdleShutdown(session)
    }
  }

  function request(sessionId: string, method: LspRequestMethod, params: unknown): Promise<unknown> {
    const session = sessionsById.get(sessionId)
    if (!session) {
      return Promise.reject(new Error('Unknown LSP session'))
    }
    return sendRequest(session, method, params)
  }

  function onDiagnostics(listener: LspDiagnosticsListener): () => void {
    diagnosticsListeners.add(listener)
    return () => diagnosticsListeners.delete(listener)
  }

  function disposeAll(): void {
    for (const session of sessionsById.values()) {
      send(session, { jsonrpc: '2.0', method: 'exit' })
      disposeSession(session)
    }
  }

  return { openDocument, changeDocument, closeDocument, request, onDiagnostics, disposeAll }
}
