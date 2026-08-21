import {
  connectCodexAppServer,
  type CodexAppServerConnection
} from './codex-app-server-jsonl-client'
import {
  parseAppServerEvent,
  parseThreadResult,
  parseTurnResult,
  type CodexAppServerEvent,
  type CodexAppServerInitializeResult,
  type CodexAppServerRequest,
  type CodexAppServerRequestId,
  type CodexAppServerThread,
  type CodexAppServerTurn
} from './codex-app-server-protocol'
import {
  createCodexAppServerProcessFactory,
  type CodexAppServerProcess,
  type CodexAppServerProcessFactory,
  type SpawnCodexAppServerOptions
} from './codex-app-server-process'
import {
  buildCodexSideQuestThreadConfig,
  resolveCodexSideQuestThreadCwd
} from './codex-side-quest-thread-config'

export type StartCodexSideQuestArgs = {
  cwd: string
  model?: string
  developerInstructions?: string
  ephemeral?: boolean
}

export type StartCodexSideQuestTurnArgs = {
  threadId: string
  text: string
  clientUserMessageId?: string
  model?: string
  effort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
}

export type CodexSideQuestManagerOptions = SpawnCodexAppServerOptions & {
  requestTimeoutMs?: number
  processFactory?: CodexAppServerProcessFactory
}

export class CodexSideQuestManager {
  private readonly processFactory: CodexAppServerProcessFactory
  private readonly eventListeners = new Set<(event: CodexAppServerEvent) => void>()
  private readonly requestListeners = new Set<(request: CodexAppServerRequest) => void>()
  private readonly loadedThreadIds = new Set<string>()
  private readonly loadingThreads = new Map<string, Promise<void>>()
  private readonly threadCwds = new Map<string, string>()
  private connection: CodexAppServerConnection | null = null
  private connecting: Promise<CodexAppServerConnection> | null = null
  private connectingProcess: CodexAppServerProcess | null = null
  private connectionGeneration = 0
  private disposed = false

  constructor(private readonly options: CodexSideQuestManagerOptions = {}) {
    this.processFactory = options.processFactory ?? createCodexAppServerProcessFactory(options)
  }

  subscribe(listener: (event: CodexAppServerEvent) => void): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  subscribeToServerRequests(listener: (request: CodexAppServerRequest) => void): () => void {
    this.requestListeners.add(listener)
    return () => this.requestListeners.delete(listener)
  }

  async getServerInfo(): Promise<CodexAppServerInitializeResult> {
    return (await this.getConnection()).initializeResult
  }

  async startSession(args: StartCodexSideQuestArgs): Promise<CodexAppServerThread> {
    const cwd = this.resolveThreadCwd(args.cwd.trim())
    if (!cwd) {
      throw new Error('A working directory is required to start a Codex Side Quest.')
    }
    const connection = await this.getConnection()
    const config = await buildCodexSideQuestThreadConfig(connection, cwd)
    const result = await connection.request('thread/start', {
      cwd,
      // Why: Side Quests explain workspace state without mutating the shared
      // worktree or pausing an independent conversation for approvals.
      approvalPolicy: 'never',
      sandbox: 'read-only',
      serviceName: 'orca_side_quest',
      ephemeral: args.ephemeral === true,
      config,
      ...(args.model ? { model: args.model } : {}),
      ...(args.developerInstructions ? { developerInstructions: args.developerInstructions } : {})
    })
    const thread = parseThreadResult(result)
    this.rememberThread(thread.id, cwd)
    return thread
  }

  async resumeSession(threadId: string, cwd?: string): Promise<CodexAppServerThread> {
    const normalizedThreadId = requireValue(threadId, 'thread id')
    const connection = await this.getConnection()
    const explicitCwd = cwd?.trim()
    const resolvedCwd =
      (explicitCwd ? this.resolveThreadCwd(explicitCwd) : undefined) ??
      this.threadCwds.get(normalizedThreadId)
    const result = await connection.request('thread/resume', {
      threadId: normalizedThreadId,
      ...(resolvedCwd ? { cwd: resolvedCwd } : {})
    })
    const thread = parseThreadResult(result)
    this.rememberThread(thread.id, resolvedCwd)
    return thread
  }

  async readSession(threadId: string): Promise<CodexAppServerThread> {
    const result = await (
      await this.getConnection()
    ).request('thread/read', {
      threadId: requireValue(threadId, 'thread id'),
      includeTurns: true
    })
    return parseThreadResult(result)
  }

  async startTurn(args: StartCodexSideQuestTurnArgs): Promise<CodexAppServerTurn> {
    const threadId = requireValue(args.threadId, 'thread id')
    const text = requireValue(args.text, 'turn text')
    const connection = await this.getConnection()
    await this.ensureThreadLoaded(connection, threadId)
    const result = await connection.request('turn/start', {
      threadId,
      input: [{ type: 'text', text, text_elements: [] }],
      ...(args.clientUserMessageId ? { clientUserMessageId: args.clientUserMessageId } : {}),
      ...(args.model ? { model: args.model } : {}),
      ...(args.effort ? { effort: args.effort } : {})
    })
    return parseTurnResult(result)
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    const connection = await this.getConnection()
    await connection.request('turn/interrupt', {
      threadId: requireValue(threadId, 'thread id'),
      turnId: requireValue(turnId, 'turn id')
    })
  }

  respondToServerRequest(id: CodexAppServerRequestId, result: unknown): void {
    if (!this.connection) {
      throw new Error('Codex app-server is not connected.')
    }
    this.connection.respond(id, result)
  }

  rejectServerRequest(id: CodexAppServerRequestId, message: string): void {
    if (!this.connection) {
      throw new Error('Codex app-server is not connected.')
    }
    this.connection.respondError(id, -32601, message)
  }

  restart(): void {
    this.connectionGeneration += 1
    this.connection?.dispose()
    try {
      this.connectingProcess?.kill()
    } catch {
      // A concurrently exiting app-server may already have released its handle.
    }
    this.connection = null
    this.connecting = null
    this.connectingProcess = null
    this.loadedThreadIds.clear()
    this.loadingThreads.clear()
  }

  dispose(): void {
    this.disposed = true
    this.restart()
    this.eventListeners.clear()
    this.requestListeners.clear()
  }

  private async getConnection(): Promise<CodexAppServerConnection> {
    if (this.disposed) {
      throw new Error('Codex Side Quest manager is disposed.')
    }
    if (this.connection) {
      return this.connection
    }
    if (this.connecting) {
      return this.connecting
    }
    const pending = connectCodexAppServer({
      processFactory: () => {
        const process = this.processFactory()
        this.connectingProcess = process
        return process
      },
      requestTimeoutMs: this.options.requestTimeoutMs
    })
    const generation = this.connectionGeneration
    this.connecting = pending
    try {
      const connection = await pending
      if (this.disposed || generation !== this.connectionGeneration) {
        connection.dispose()
        throw new Error('Codex app-server connection was superseded.')
      }
      this.connection = connection
      this.attachConnection(connection)
      return connection
    } finally {
      if (this.connecting === pending) {
        this.connecting = null
        this.connectingProcess = null
      }
    }
  }

  private attachConnection(connection: CodexAppServerConnection): void {
    connection.onNotification(({ method, params }) => {
      try {
        const event = parseAppServerEvent(method, params)
        if (event) {
          this.emit(event)
        }
      } catch (error) {
        this.emit({
          type: 'error',
          threadId: null,
          message: error instanceof Error ? error.message : String(error)
        })
      }
    })
    connection.onServerRequest((request) => {
      if (this.requestListeners.size === 0) {
        connection.respondError(
          request.id,
          -32601,
          `Unsupported app-server request: ${request.method}`
        )
        return
      }
      for (const listener of this.requestListeners) {
        listener(request)
      }
    })
    connection.onClose(() => {
      if (this.connection === connection) {
        this.connection = null
        this.loadedThreadIds.clear()
        this.loadingThreads.clear()
      }
    })
  }

  private async ensureThreadLoaded(
    connection: CodexAppServerConnection,
    threadId: string
  ): Promise<void> {
    if (this.loadedThreadIds.has(threadId)) {
      return
    }
    const existing = this.loadingThreads.get(threadId)
    if (existing) {
      return existing
    }
    const pending = this.resumeThread(connection, threadId)
    this.loadingThreads.set(threadId, pending)
    try {
      await pending
    } finally {
      if (this.loadingThreads.get(threadId) === pending) {
        this.loadingThreads.delete(threadId)
      }
    }
  }

  private async resumeThread(
    connection: CodexAppServerConnection,
    threadId: string
  ): Promise<void> {
    const cwd = this.threadCwds.get(threadId)
    const result = await connection.request('thread/resume', {
      threadId,
      ...(cwd ? { cwd } : {})
    })
    const thread = parseThreadResult(result)
    this.rememberThread(thread.id, cwd)
  }

  private rememberThread(threadId: string, cwd?: string): void {
    this.loadedThreadIds.add(threadId)
    if (cwd) {
      this.threadCwds.set(threadId, cwd)
    }
  }

  private resolveThreadCwd(cwd: string): string {
    return resolveCodexSideQuestThreadCwd(cwd, this.options.wslDistro)
  }

  private emit(event: CodexAppServerEvent): void {
    for (const listener of this.eventListeners) {
      listener(event)
    }
  }
}

function requireValue(value: string, label: string): string {
  const trimmed = value.trim()
  if (!trimmed) {
    throw new Error(`Codex Side Quest ${label} is required.`)
  }
  return trimmed
}
