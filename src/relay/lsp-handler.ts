/* eslint-disable max-lines -- Why: relay LSP request registration and session
lifecycle recovery need to stay in one file so local/remote protocol behavior
is easy to audit. */
import type {
  LspCompletionResult,
  LspDocumentChange,
  LspDocumentContext,
  LspHover,
  LspLocation,
  LspRequestContext,
  LspServerStatus
} from '../shared/lsp-types'
import { resolveLanguageServerCommand } from '../main/lsp/language-server-registry'
import { LspProcessSession } from '../main/lsp/lsp-process-session'
import type { RelayDispatcher } from './dispatcher'

type ManagedSession = {
  key: string
  session: LspProcessSession
  idleTimer: ReturnType<typeof setTimeout> | null
}

type TrackedDocument = LspDocumentContext & { documentIds: Set<string> }

const IDLE_SESSION_TTL_MS = 60_000

function sessionKey(args: {
  worktreePath: string
  languageId: string
  runtimeEnvironmentId?: string
}): string {
  return `${args.runtimeEnvironmentId ?? 'default'}\0${args.worktreePath}\0${args.languageId}`
}

function assertRuntimeSupported(args: { runtimeEnvironmentId?: string }): void {
  if (args.runtimeEnvironmentId) {
    throw new Error('LSP is not available for runtime environments yet')
  }
}

function documentReferenceId(args: { filePath: string; documentId?: string }): string {
  return args.documentId ?? `legacy:${args.filePath}`
}

export class LspHandler {
  private readonly dispatcher: RelayDispatcher
  private sessions = new Map<string, ManagedSession>()
  private pendingSessions = new Map<string, Promise<ManagedSession>>()
  private openDocuments = new Map<string, Map<string, TrackedDocument>>()
  private disposed = false

  constructor(dispatcher: RelayDispatcher) {
    this.dispatcher = dispatcher
    dispatcher.onRequest('lsp.getStatus', (params) =>
      this.getStatus(params as unknown as LspDocumentChange)
    )
    dispatcher.onRequest('lsp.openDocument', (params) =>
      this.openDocument(params as unknown as LspDocumentContext)
    )
    dispatcher.onRequest('lsp.changeDocument', async (params) => {
      await this.changeDocument(params as unknown as LspDocumentChange)
      return { ok: true }
    })
    dispatcher.onRequest('lsp.closeDocument', async (params) => {
      await this.closeDocument(params as unknown as Omit<LspDocumentChange, 'content'>)
      return { ok: true }
    })
    dispatcher.onRequest('lsp.completion', (params) =>
      this.completion(params as unknown as LspRequestContext)
    )
    dispatcher.onRequest('lsp.hover', (params) =>
      this.hover(params as unknown as LspRequestContext)
    )
    dispatcher.onRequest('lsp.definition', (params) =>
      this.definition(params as unknown as LspRequestContext)
    )
    dispatcher.onRequest('lsp.getStats', async () => this.getStats())
  }

  async getStatus(args: LspDocumentChange): Promise<LspServerStatus> {
    if (args.runtimeEnvironmentId) {
      return {
        state: 'unavailable',
        languageId: args.languageId,
        reason: 'LSP is not available for runtime environments yet'
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
    const entry = await this.getOrCreateSession(args)
    try {
      await (wasTracked
        ? entry.session.changeDocument(args.filePath, args.content)
        : entry.session.openDocument(args.filePath, args.languageId, args.content))
      this.trackOpenDocument(args)
    } catch (error) {
      await this.disposeBrokenSession(entry)
      throw error
    }
    return { state: 'available', languageId: args.languageId }
  }

  async changeDocument(args: LspDocumentChange): Promise<void> {
    assertRuntimeSupported(args)
    const key = sessionKey(args)
    const tracked = this.updateTrackedDocument(args)
    const entry = this.sessions.get(key)
    if (!entry) {
      if (tracked) {
        const recreated = await this.getOrCreateSession(tracked)
        await recreated.session.changeDocument(args.filePath, args.content)
      }
      return
    }
    this.cancelIdleDispose(entry)
    try {
      await entry.session.changeDocument(args.filePath, args.content)
    } catch (error) {
      await this.disposeBrokenSession(entry)
      if (!tracked) {
        throw error
      }
      const recreated = await this.getOrCreateSession(tracked)
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
    const entry = this.sessions.get(key)
    if (!entry) {
      return
    }
    try {
      await entry.session.closeDocument(args.filePath)
    } catch (error) {
      await this.disposeBrokenSession(entry)
      throw error
    }
    if (entry.session.getOpenDocumentCount() === 0) {
      this.scheduleIdleDispose(entry)
    }
  }

  async completion(args: LspRequestContext): Promise<LspCompletionResult | null> {
    assertRuntimeSupported(args)
    const entry = await this.getOrCreateSession({ ...args, content: args.content ?? '' })
    try {
      return await entry.session.completion(args.filePath, args.position, args.content)
    } catch {
      await this.disposeBrokenSession(entry)
      return await this.retryRequest(args, (retried) =>
        retried.session.completion(args.filePath, args.position, args.content)
      )
    }
  }

  async hover(args: LspRequestContext): Promise<LspHover | null> {
    assertRuntimeSupported(args)
    const entry = await this.getOrCreateSession({ ...args, content: args.content ?? '' })
    try {
      return await entry.session.hover(args.filePath, args.position, args.content)
    } catch {
      await this.disposeBrokenSession(entry)
      return await this.retryRequest(args, (retried) =>
        retried.session.hover(args.filePath, args.position, args.content)
      )
    }
  }

  async definition(args: LspRequestContext): Promise<LspLocation[]> {
    assertRuntimeSupported(args)
    const entry = await this.getOrCreateSession({ ...args, content: args.content ?? '' })
    try {
      return await entry.session.definition(args.filePath, args.position, args.content)
    } catch {
      await this.disposeBrokenSession(entry)
      return await this.retryRequest(args, (retried) =>
        retried.session.definition(args.filePath, args.position, args.content)
      )
    }
  }

  getStats(): {
    activeSessions: number
    sessions: {
      key: string
      worktreePath: string
      languageId: string
      runtimeEnvironmentId?: string
    }[]
  } {
    return {
      activeSessions: this.sessions.size,
      sessions: Array.from(this.sessions.entries()).map(([key, entry]) => {
        const [runtimeEnvironmentId, worktreePath, languageId] = key.split('\0')
        return {
          key,
          runtimeEnvironmentId:
            runtimeEnvironmentId === 'default' ? undefined : runtimeEnvironmentId,
          worktreePath,
          languageId,
          ...entry.session.getStats()
        }
      })
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    const sessions = Array.from(this.sessions.values())
    this.sessions.clear()
    this.pendingSessions.clear()
    this.openDocuments.clear()
    await Promise.all(
      sessions.map(async (entry) => {
        if (entry.idleTimer) {
          clearTimeout(entry.idleTimer)
        }
        await entry.session.dispose()
      })
    )
  }

  private async getOrCreateSession(args: LspDocumentContext): Promise<ManagedSession> {
    if (this.disposed) {
      throw new Error('LSP handler is shutting down')
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
    // Why: concurrent opens over SSH can race command discovery. Deduping the
    // creation promise prevents one relay-side language server from being
    // overwritten and left untracked.
    const created = this.createSession(key, args)
    this.pendingSessions.set(key, created)
    try {
      return await created
    } finally {
      if (this.pendingSessions.get(key) === created) {
        this.pendingSessions.delete(key)
      }
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
    key: string,
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

  private async retryRequest<T>(
    args: LspRequestContext,
    request: (entry: ManagedSession) => Promise<T>
  ): Promise<T> {
    const retried = await this.getOrCreateSession({ ...args, content: args.content ?? '' })
    try {
      return await request(retried)
    } catch (error) {
      await this.disposeBrokenSession(retried)
      throw error
    }
  }

  private async createSession(key: string, args: LspDocumentContext): Promise<ManagedSession> {
    if (this.disposed) {
      throw new Error('LSP handler is shutting down')
    }
    const resolved = await resolveLanguageServerCommand(args.languageId)
    if (this.disposed) {
      throw new Error('LSP handler is shutting down')
    }
    if (!resolved.ok) {
      throw new Error(resolved.reason)
    }
    const entry: ManagedSession = {
      key,
      session: new LspProcessSession({
        rootPath: args.worktreePath,
        languageId: args.languageId,
        server: resolved.command,
        onDiagnostics: (event) => {
          this.dispatcher.notify('lsp.diagnostics', {
            worktreePath: args.worktreePath,
            filePath: event.filePath,
            languageId: event.languageId,
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
        throw new Error('LSP handler is shutting down')
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
    // Why: relay request methods avoid resending content. Recreated server
    // processes need the relay's last synced open docs replayed first.
    for (const document of documents.values()) {
      await entry.session.openDocument(document.filePath, document.languageId, document.content)
    }
  }

  private clearTrackedDiagnostics(key: string): void {
    const documents = this.openDocuments.get(key)
    if (!documents) {
      return
    }
    for (const document of documents.values()) {
      this.dispatcher.notify('lsp.diagnostics', {
        worktreePath: document.worktreePath,
        filePath: document.filePath,
        languageId: document.languageId,
        runtimeEnvironmentId: document.runtimeEnvironmentId,
        diagnostics: []
      })
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
    this.clearTrackedDiagnostics(entry.key)
    await entry.session.dispose().catch(() => undefined)
  }
}
