/* eslint-disable max-lines -- Why: this service owns the local/SSH routing
boundary for all LSP lifecycle methods; keeping the paired paths together makes
failure cleanup and diagnostics forwarding easier to audit. */
import { BrowserWindow } from 'electron'
import type {
  LspCompletionResult,
  LspDiagnosticsEvent,
  LspDocumentChange,
  LspDocumentContext,
  LspHover,
  LspLocation,
  LspRequestContext,
  LspServerStatus
} from '../../shared/lsp-types'
import { getActiveMultiplexer, onActiveMultiplexerReady } from '../ipc/ssh'
import { resolveLanguageServerCommand } from './language-server-registry'
import { LspProcessSession, type LspProcessStats } from './lsp-process-session'

type SessionKey = string

type ManagedSession = {
  key: SessionKey
  worktreePath: string
  languageId: string
  connectionId?: string
  runtimeEnvironmentId?: string
  session: LspProcessSession
  idleTimer: ReturnType<typeof setTimeout> | null
}

type TrackedDocument = LspDocumentContext & { documentIds: Set<string> }
type ActiveMultiplexer = NonNullable<ReturnType<typeof getActiveMultiplexer>>

export type LspServiceStats = {
  activeSessions: number
  sessions: ({
    key: string
    worktreePath: string
    languageId: string
    connectionId?: string
    runtimeEnvironmentId?: string
  } & LspProcessStats)[]
}

const IDLE_SESSION_TTL_MS = 60_000

function sessionKey(args: {
  worktreePath: string
  languageId: string
  connectionId?: string
  runtimeEnvironmentId?: string
}): string {
  return `${args.connectionId ?? 'local'}\0${args.runtimeEnvironmentId ?? 'default'}\0${args.worktreePath}\0${args.languageId}`
}

function assertRuntimeSupported(args: {
  runtimeEnvironmentId?: string
  connectionId?: string
}): void {
  if (args.runtimeEnvironmentId) {
    throw new Error('LSP is not available for runtime environments yet')
  }
}

function documentReferenceId(args: { filePath: string; documentId?: string }): string {
  return args.documentId ?? `legacy:${args.filePath}`
}

function isRelayMethodNotFound(error: unknown, method: string): boolean {
  const candidate = error as { code?: unknown; message?: unknown }
  return (
    candidate.code === -32601 ||
    (typeof candidate.message === 'string' &&
      candidate.message.includes(`Method not found: ${method}`))
  )
}

function publishDiagnostics(event: LspDiagnosticsEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('lsp:diagnostics', event)
    }
  }
}

export class LspService {
  private sessions = new Map<SessionKey, ManagedSession>()
  private pendingSessions = new Map<SessionKey, Promise<ManagedSession>>()
  private openDocuments = new Map<SessionKey, Map<string, TrackedDocument>>()
  private remoteDiagnosticsDisposers = new Map<string, () => void>()
  private remoteDiagnosticsMultiplexers = new Map<string, ActiveMultiplexer>()
  private remoteSessionMultiplexers = new Map<SessionKey, ActiveMultiplexer>()
  private readonly disposeMultiplexerReadyListener: () => void
  private disposed = false

  constructor() {
    this.disposeMultiplexerReadyListener = onActiveMultiplexerReady((connectionId) => {
      void this.reopenRemoteDocumentsForConnection(connectionId).catch((error) => {
        console.warn(`[lsp] Failed to reopen remote documents for ${connectionId}:`, error)
      })
    })
  }

  async getStatus(args: {
    worktreePath: string
    languageId: string
    connectionId?: string
    runtimeEnvironmentId?: string
  }): Promise<LspServerStatus> {
    if (args.runtimeEnvironmentId) {
      return {
        state: 'unavailable',
        languageId: args.languageId,
        reason: 'LSP is not available for runtime environments yet'
      }
    }
    if (args.connectionId) {
      const mux = getActiveMultiplexer(args.connectionId)
      if (!mux || mux.isDisposed()) {
        return {
          state: 'unavailable',
          languageId: args.languageId,
          reason: `No active SSH connection for "${args.connectionId}"`
        }
      }
      try {
        return (await mux.request('lsp.getStatus', {
          worktreePath: args.worktreePath,
          languageId: args.languageId
        })) as LspServerStatus
      } catch (error) {
        if (isRelayMethodNotFound(error, 'lsp.getStatus')) {
          return {
            state: 'unavailable',
            languageId: args.languageId,
            reason: 'Remote relay does not support LSP yet; reconnect SSH to update it'
          }
        }
        throw error
      }
    }
    const resolved = await resolveLanguageServerCommand(args.languageId)
    if (!resolved.ok) {
      return { state: 'unavailable', languageId: args.languageId, reason: resolved.reason }
    }
    return {
      state: 'available',
      languageId: args.languageId,
      command: [resolved.command.command, ...resolved.command.args].join(' ')
    }
  }

  async openDocument(args: LspDocumentContext): Promise<LspServerStatus> {
    assertRuntimeSupported(args)
    const key = sessionKey(args)
    const wasTracked = this.openDocuments.get(key)?.has(args.filePath) ?? false
    if (args.connectionId) {
      this.ensureRemoteDiagnosticsHandler(args.connectionId)
      await this.ensureRemoteDocumentsOpen(args)
      const status = await this.remoteRequest<LspServerStatus>(
        args.connectionId,
        'lsp.openDocument',
        args
      )
      this.trackOpenDocument(args)
      this.rememberRemoteMultiplexer(args)
      return status
    }
    const session = await this.getOrCreateLocalSession(args)
    try {
      await (wasTracked
        ? session.session.changeDocument(args.filePath, args.content)
        : session.session.openDocument(args.filePath, args.languageId, args.content))
      this.trackOpenDocument(args)
    } catch (error) {
      await this.disposeBrokenSession(session)
      throw error
    }
    return {
      state: 'available',
      languageId: args.languageId
    }
  }

  async changeDocument(args: LspDocumentChange): Promise<void> {
    assertRuntimeSupported(args)
    const tracked = this.updateTrackedDocument(args)
    if (args.connectionId) {
      await this.ensureRemoteDocumentsOpen(args)
      await this.remoteRequest(args.connectionId, 'lsp.changeDocument', args)
      return
    }
    const existing = this.sessions.get(sessionKey(args))
    if (!existing) {
      if (tracked) {
        const recreated = await this.getOrCreateLocalSession(tracked)
        await recreated.session.changeDocument(args.filePath, args.content)
      }
      return
    }
    this.cancelIdleDispose(existing)
    try {
      await existing.session.changeDocument(args.filePath, args.content)
    } catch (error) {
      await this.disposeBrokenSession(existing)
      if (!tracked) {
        throw error
      }
      const recreated = await this.getOrCreateLocalSession(tracked)
      try {
        await recreated.session.changeDocument(args.filePath, args.content)
      } catch (retryError) {
        await this.disposeBrokenSession(recreated)
        throw retryError
      }
    }
  }

  async closeDocument(args: Omit<LspDocumentChange, 'content'>): Promise<void> {
    assertRuntimeSupported(args)
    const key = sessionKey(args)
    const shouldCloseDocument = this.releaseOpenDocument(key, args)
    if (!shouldCloseDocument) {
      return
    }
    if (args.connectionId) {
      await this.remoteRequest(args.connectionId, 'lsp.closeDocument', args)
      return
    }
    const existing = this.sessions.get(key)
    if (!existing) {
      return
    }
    try {
      await existing.session.closeDocument(args.filePath)
    } catch (error) {
      await this.disposeBrokenSession(existing)
      throw error
    }
    if (existing.session.getOpenDocumentCount() === 0) {
      this.scheduleIdleDispose(existing)
    }
  }

  async completion(args: LspRequestContext): Promise<LspCompletionResult | null> {
    assertRuntimeSupported(args)
    if (args.connectionId) {
      await this.ensureRemoteDocumentsOpen(args)
      return this.remoteRequest(args.connectionId, 'lsp.completion', args)
    }
    const session = await this.getOrCreateLocalSession({
      ...args,
      worktreeId: args.worktreeId,
      content: args.content ?? ''
    })
    try {
      return await session.session.completion(args.filePath, args.position, args.content)
    } catch {
      await this.disposeBrokenSession(session)
      return await this.retryLocalRequest(args, (entry) =>
        entry.session.completion(args.filePath, args.position, args.content)
      )
    }
  }

  async hover(args: LspRequestContext): Promise<LspHover | null> {
    assertRuntimeSupported(args)
    if (args.connectionId) {
      await this.ensureRemoteDocumentsOpen(args)
      return this.remoteRequest(args.connectionId, 'lsp.hover', args)
    }
    const session = await this.getOrCreateLocalSession({
      ...args,
      worktreeId: args.worktreeId,
      content: args.content ?? ''
    })
    try {
      return await session.session.hover(args.filePath, args.position, args.content)
    } catch {
      await this.disposeBrokenSession(session)
      return await this.retryLocalRequest(args, (entry) =>
        entry.session.hover(args.filePath, args.position, args.content)
      )
    }
  }

  async definition(args: LspRequestContext): Promise<LspLocation[]> {
    assertRuntimeSupported(args)
    if (args.connectionId) {
      await this.ensureRemoteDocumentsOpen(args)
      return this.remoteRequest(args.connectionId, 'lsp.definition', args)
    }
    const session = await this.getOrCreateLocalSession({
      ...args,
      worktreeId: args.worktreeId,
      content: args.content ?? ''
    })
    try {
      return await session.session.definition(args.filePath, args.position, args.content)
    } catch {
      await this.disposeBrokenSession(session)
      return await this.retryLocalRequest(args, (entry) =>
        entry.session.definition(args.filePath, args.position, args.content)
      )
    }
  }

  getStats(): LspServiceStats {
    return {
      activeSessions: this.sessions.size,
      sessions: Array.from(this.sessions.values()).map((entry) => ({
        key: entry.key,
        worktreePath: entry.worktreePath,
        languageId: entry.languageId,
        connectionId: entry.connectionId,
        runtimeEnvironmentId: entry.runtimeEnvironmentId,
        ...entry.session.getStats()
      }))
    }
  }

  async disposeAll(): Promise<void> {
    this.disposed = true
    this.disposeMultiplexerReadyListener()
    const sessions = Array.from(this.sessions.values())
    this.sessions.clear()
    this.pendingSessions.clear()
    this.openDocuments.clear()
    this.remoteDiagnosticsMultiplexers.clear()
    this.remoteSessionMultiplexers.clear()
    for (const dispose of this.remoteDiagnosticsDisposers.values()) {
      dispose()
    }
    this.remoteDiagnosticsDisposers.clear()
    await Promise.all(
      sessions.map(async (entry) => {
        if (entry.idleTimer) {
          clearTimeout(entry.idleTimer)
        }
        await entry.session.dispose()
      })
    )
  }

  private async remoteRequest<T>(connectionId: string, method: string, args: unknown): Promise<T> {
    const mux = getActiveMultiplexer(connectionId)
    if (!mux || mux.isDisposed()) {
      throw new Error(`No active SSH connection for "${connectionId}"`)
    }
    return (await mux.request(method, args as Record<string, unknown>)) as T
  }

  private ensureRemoteDiagnosticsHandler(connectionId: string): void {
    const mux = getActiveMultiplexer(connectionId)
    if (!mux || mux.isDisposed()) {
      return
    }
    if (this.remoteDiagnosticsMultiplexers.get(connectionId) === mux) {
      return
    }
    this.remoteDiagnosticsDisposers.get(connectionId)?.()
    this.remoteDiagnosticsDisposers.delete(connectionId)
    this.remoteDiagnosticsMultiplexers.delete(connectionId)
    const disposeDiagnostics = mux.onNotificationByMethod('lsp.diagnostics', (params) => {
      const event = params as unknown as Omit<LspDiagnosticsEvent, 'connectionId'>
      publishDiagnostics({ ...event, connectionId })
    })
    const disposeMux = mux.onDispose(() => {
      this.remoteDiagnosticsDisposers.delete(connectionId)
      this.remoteDiagnosticsMultiplexers.delete(connectionId)
      for (const [key, trackedMux] of this.remoteSessionMultiplexers) {
        if (trackedMux === mux) {
          this.clearTrackedDiagnostics(key, connectionId)
          this.remoteSessionMultiplexers.delete(key)
        }
      }
    })
    this.remoteDiagnosticsDisposers.set(connectionId, () => {
      disposeDiagnostics()
      disposeMux()
    })
    this.remoteDiagnosticsMultiplexers.set(connectionId, mux)
  }

  private async reopenRemoteDocumentsForConnection(connectionId: string): Promise<void> {
    if (this.disposed) {
      return
    }
    const mux = getActiveMultiplexer(connectionId)
    if (!mux || mux.isDisposed()) {
      return
    }
    this.ensureRemoteDiagnosticsHandler(connectionId)
    for (const documents of this.openDocuments.values()) {
      const firstDocument = documents.values().next().value
      if (!firstDocument || firstDocument.connectionId !== connectionId) {
        continue
      }
      try {
        await this.ensureRemoteDocumentsOpen(firstDocument, { force: true })
      } catch {
        // Why: readiness is an opportunistic recovery signal; user-initiated
        // requests still surface relay/version failures with their own context.
      }
    }
  }

  private rememberRemoteMultiplexer(args: {
    connectionId?: string
    worktreePath: string
    languageId: string
    runtimeEnvironmentId?: string
  }): void {
    if (!args.connectionId) {
      return
    }
    const mux = getActiveMultiplexer(args.connectionId)
    if (mux && !mux.isDisposed()) {
      this.remoteSessionMultiplexers.set(sessionKey(args), mux)
    }
  }

  private trackOpenDocument(args: LspDocumentContext): void {
    const key = sessionKey(args)
    const documents = this.openDocuments.get(key) ?? new Map<string, TrackedDocument>()
    const existing = documents.get(args.filePath)
    const documentIds = existing?.documentIds ?? new Set<string>()
    documentIds.add(documentReferenceId(args))
    documents.set(args.filePath, {
      ...args,
      documentIds
    })
    this.openDocuments.set(key, documents)
  }

  private updateTrackedDocument(args: LspDocumentChange): TrackedDocument | undefined {
    const documents = this.openDocuments.get(sessionKey(args))
    const tracked = documents?.get(args.filePath)
    if (!tracked) {
      return undefined
    }
    tracked.content = args.content
    return tracked
  }

  private releaseOpenDocument(
    key: SessionKey,
    args: { filePath: string; documentId?: string }
  ): boolean {
    const documents = this.openDocuments.get(key)
    if (!documents) {
      return true
    }
    const tracked = documents.get(args.filePath)
    if (!tracked) {
      return true
    }
    tracked.documentIds.delete(documentReferenceId(args))
    if (tracked.documentIds.size > 0) {
      return false
    }
    documents.delete(args.filePath)
    if (documents.size === 0) {
      this.openDocuments.delete(key)
    }
    return true
  }

  private async ensureRemoteDocumentsOpen(
    args: {
      connectionId?: string
      worktreePath: string
      languageId: string
      runtimeEnvironmentId?: string
    },
    options: { force?: boolean } = {}
  ): Promise<void> {
    if (!args.connectionId) {
      return
    }
    const mux = getActiveMultiplexer(args.connectionId)
    if (!mux || mux.isDisposed()) {
      throw new Error(`No active SSH connection for "${args.connectionId}"`)
    }
    const key = sessionKey(args)
    if (!options.force && this.remoteSessionMultiplexers.get(key) === mux) {
      return
    }
    this.ensureRemoteDiagnosticsHandler(args.connectionId)
    const documents = this.openDocuments.get(key)
    if (!documents) {
      this.remoteSessionMultiplexers.set(key, mux)
      return
    }
    // Why: a new SSH multiplexer usually means a new relay process. Re-open
    // tracked docs once so request-time completions still avoid sending content.
    for (const document of documents.values()) {
      const { documentIds: _documentIds, ...payload } = document
      for (const documentId of document.documentIds) {
        await mux.request('lsp.openDocument', { ...payload, documentId })
      }
    }
    this.remoteSessionMultiplexers.set(key, mux)
  }

  private clearTrackedDiagnostics(key: SessionKey, connectionId?: string): void {
    const documents = this.openDocuments.get(key)
    if (!documents) {
      return
    }
    for (const document of documents.values()) {
      publishDiagnostics({
        worktreePath: document.worktreePath,
        filePath: document.filePath,
        languageId: document.languageId,
        connectionId,
        runtimeEnvironmentId: document.runtimeEnvironmentId,
        diagnostics: []
      })
    }
  }

  private async retryLocalRequest<T>(
    args: LspRequestContext,
    request: (entry: ManagedSession) => Promise<T>
  ): Promise<T> {
    const retried = await this.getOrCreateLocalSession({
      ...args,
      worktreeId: args.worktreeId,
      content: args.content ?? ''
    })
    try {
      return await request(retried)
    } catch (error) {
      await this.disposeBrokenSession(retried)
      throw error
    }
  }

  private async getOrCreateLocalSession(args: LspDocumentContext): Promise<ManagedSession> {
    if (this.disposed) {
      throw new Error('LSP service is shutting down')
    }
    const key = sessionKey(args)
    const existing = this.sessions.get(key)
    if (existing) {
      this.cancelIdleDispose(existing)
      return existing
    }
    const pending = this.pendingSessions.get(key)
    if (pending) {
      return pending
    }
    // Why: restoring split panes can open same-language files concurrently.
    // Share one creation promise so command discovery cannot orphan an
    // overwritten language-server process for the same session key.
    const created = this.createLocalSession(key, args)
    this.pendingSessions.set(key, created)
    try {
      return await created
    } finally {
      if (this.pendingSessions.get(key) === created) {
        this.pendingSessions.delete(key)
      }
    }
  }

  private async createLocalSession(
    key: SessionKey,
    args: LspDocumentContext
  ): Promise<ManagedSession> {
    if (this.disposed) {
      throw new Error('LSP service is shutting down')
    }
    const resolved = await resolveLanguageServerCommand(args.languageId)
    if (this.disposed) {
      throw new Error('LSP service is shutting down')
    }
    if (!resolved.ok) {
      throw new Error(resolved.reason)
    }
    const entry: ManagedSession = {
      key,
      worktreePath: args.worktreePath,
      languageId: args.languageId,
      connectionId: args.connectionId,
      runtimeEnvironmentId: args.runtimeEnvironmentId,
      session: new LspProcessSession({
        rootPath: args.worktreePath,
        languageId: args.languageId,
        server: resolved.command,
        connectionId: args.connectionId,
        onDiagnostics: (event) => {
          publishDiagnostics({
            worktreePath: args.worktreePath,
            filePath: event.filePath,
            languageId: event.languageId,
            connectionId: args.connectionId,
            runtimeEnvironmentId: args.runtimeEnvironmentId,
            diagnostics: event.diagnostics
          })
        }
      }),
      idleTimer: null
    }
    this.sessions.set(key, entry)
    try {
      await this.reopenTrackedDocuments(entry)
      if (this.disposed) {
        throw new Error('LSP service is shutting down')
      }
    } catch (error) {
      this.sessions.delete(key)
      await entry.session.dispose().catch(() => undefined)
      throw error
    }
    return entry
  }

  private async reopenTrackedDocuments(entry: ManagedSession): Promise<void> {
    const documents = this.openDocuments.get(entry.key)
    if (!documents) {
      return
    }
    // Why: request paths intentionally omit document content for perf. If a
    // language-server process is recreated, replay the last synced open docs.
    for (const document of documents.values()) {
      await entry.session.openDocument(document.filePath, document.languageId, document.content)
    }
  }

  private cancelIdleDispose(entry: ManagedSession): void {
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer)
      entry.idleTimer = null
    }
  }

  private scheduleIdleDispose(entry: ManagedSession): void {
    this.cancelIdleDispose(entry)
    // Why: language servers hold project indexes and file handles. Keep the
    // server warm for quick tab switches, then tear it down once Orca has no
    // open documents for that worktree/language.
    entry.idleTimer = setTimeout(() => {
      if (entry.session.getOpenDocumentCount() > 0) {
        return
      }
      this.sessions.delete(entry.key)
      void entry.session.dispose()
    }, IDLE_SESSION_TTL_MS)
    entry.idleTimer.unref?.()
  }

  private async disposeBrokenSession(entry: ManagedSession): Promise<void> {
    this.sessions.delete(entry.key)
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer)
      entry.idleTimer = null
    }
    this.clearTrackedDiagnostics(entry.key, entry.connectionId)
    await entry.session.dispose().catch(() => undefined)
  }
}

export const lspService = new LspService()
