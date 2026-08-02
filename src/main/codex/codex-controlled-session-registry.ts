import { CodexControlledSessionStateStore } from './codex-controlled-session-state'
import { submitControlledInitialTurn } from './codex-controlled-initial-turn'
import { CodexUnixAppServerClient } from './codex-unix-app-server-client'
import {
  assertControlledServerIdentity,
  assertControlledThreadAlive,
  buildControlledThreadResumeParams,
  buildControlledThreadStartParams,
  buildControlledVisibleResumeCommand,
  controlledLaunchOutcomeUnknown,
  extractControlledThreadId,
  failControlledTerminalIdentity,
  getControlledLaunchFingerprint,
  getControlledSocketPath,
  getControlledStatePath,
  isSameControlledLaunch,
  resolveControlledCodexCommand,
  startControlledCodexServer,
  stopControlledCodexServer,
  type ControlledCodexCommand,
  type ControlledCodexServer,
  type CodexControlledSessionLaunch
} from './codex-controlled-session-launch'
import type {
  CodexControlledNewSessionLaunch,
  CodexControlledSessionIdentity,
  CodexControlledSessionLaunchResult,
  CodexControlledSessionManagerOptions
} from './codex-controlled-session-manager'

export type ControlledCodexSession = {
  launch: CodexControlledSessionLaunch
  socketPath: string
  server: ControlledCodexServer
  client: CodexUnixAppServerClient
  state: CodexControlledSessionStateStore
  terminal: CodexControlledSessionIdentity
  missing: boolean
  terminalClosed: boolean
}

export class CodexControlledSessionRegistry {
  private readonly sessions = new Map<string, ControlledCodexSession>()

  constructor(
    private readonly options: CodexControlledSessionManagerOptions,
    private readonly socketRoot: () => string,
    private readonly onNotification: (
      session: ControlledCodexSession,
      method: string,
      params: Record<string, unknown>
    ) => void,
    private readonly onMissing: (conversationId: string) => void,
    private readonly assertCanSubmit: (session: ControlledCodexSession) => void,
    private readonly assertCanLaunch: (input: CodexControlledSessionLaunch) => void
  ) {}

  get(conversationId: string): ControlledCodexSession | undefined {
    return this.sessions.get(conversationId)
  }

  values(): IterableIterator<ControlledCodexSession> {
    return this.sessions.values()
  }

  async launch(input: CodexControlledSessionLaunch): Promise<CodexControlledSessionLaunchResult> {
    const existing = this.sessions.get(input.conversationId)
    if (existing) {
      if (!isSameControlledLaunch(existing.launch, input)) {
        throw new Error('controlled Codex conversation identity mismatch')
      }
      existing.terminal = await this.refresh(existing)
      this.assertCanLaunch(existing.launch)
      return { identity: existing.terminal, disposition: 'reused', surface: 'visible' }
    }
    const command = resolveControlledCodexCommand(input.command)
    const socketPath = getControlledSocketPath(this.socketRoot(), input.conversationId)
    const server = await startControlledCodexServer(
      input,
      socketPath,
      this.options.spawnProcess,
      command
    )
    let client: CodexUnixAppServerClient | null = null
    let visibleIdentity: CodexControlledSessionIdentity | null = null
    try {
      this.assertCanLaunch(input)
      client = await this.connect(input, socketPath)
      this.assertCanLaunch(input)
      await client.request('thread/resume', buildControlledThreadResumeParams(input))
      this.assertCanLaunch(input)
      visibleIdentity = await this.createReadyTerminal(input, socketPath, command, (created) => {
        visibleIdentity = created
      })
      await assertControlledThreadAlive(client, input.threadId)
      this.assertCanLaunch(input)
      const session = this.createSession(input, socketPath, server, client, visibleIdentity)
      this.sessions.set(input.conversationId, session)
      return { identity: visibleIdentity, disposition: 'created', surface: 'visible' }
    } catch (error) {
      try {
        await this.rollbackFailedLaunch(input, socketPath, server, client, visibleIdentity)
      } catch (cleanupError) {
        Object.assign(asError(error), { cleanupError })
      }
      throw error
    }
  }

  async launchNew(
    input: CodexControlledNewSessionLaunch,
    command: ControlledCodexCommand = resolveControlledCodexCommand(input.command)
  ): Promise<CodexControlledSessionLaunchResult> {
    const existing = this.sessions.get(input.conversationId)
    if (existing) {
      this.assertNewLaunchMatches(existing.launch, input)
      existing.terminal = await this.refresh(existing)
      this.assertCanLaunch(existing.launch)
      await this.submitInitialPromptIfPresent(existing, input)
      return { identity: existing.terminal, disposition: 'reused', surface: 'visible' }
    }
    const socketPath = getControlledSocketPath(this.socketRoot(), input.conversationId)
    const provisional = { ...input, threadId: 'pending' }
    const server = await startControlledCodexServer(
      provisional,
      socketPath,
      this.options.spawnProcess,
      command
    )
    let client: CodexUnixAppServerClient | null = null
    let launch: CodexControlledSessionLaunch | null = null
    let identity: CodexControlledSessionIdentity | null = null
    let threadStartAttempted = false
    try {
      this.assertCanLaunch(provisional)
      client = await this.connect(provisional, socketPath)
      this.assertCanLaunch(provisional)
      threadStartAttempted = true
      const started = await client.request(
        'thread/start',
        buildControlledThreadStartParams(provisional)
      )
      launch = { ...input, threadId: extractControlledThreadId(started) }
      this.assertCanLaunch(launch)
      identity = await this.createReadyTerminal(launch, socketPath, command, (created) => {
        identity = created
      })
      await assertControlledThreadAlive(client, launch.threadId)
      this.assertCanLaunch(launch)
      const session = this.createSession(launch, socketPath, server, client, identity)
      this.sessions.set(input.conversationId, session)
      await this.submitInitialPromptIfPresent(session, input)
      return { identity, disposition: 'created', surface: 'visible' }
    } catch (error) {
      if (this.sessions.has(input.conversationId)) {
        throw controlledLaunchOutcomeUnknown(error)
      }
      try {
        await this.rollbackFailedLaunch(launch ?? provisional, socketPath, server, client, identity)
      } catch (cleanupError) {
        Object.assign(asError(error), { cleanupError })
      }
      throw threadStartAttempted ? controlledLaunchOutcomeUnknown(error) : error
    }
  }

  async refresh(session: ControlledCodexSession): Promise<CodexControlledSessionIdentity> {
    const current = await this.options.waitForVisibleTerminal(session.terminal)
    if (
      current.terminalPaneKey !== session.terminal.terminalPaneKey ||
      current.worktreeId !== session.terminal.worktreeId ||
      current.terminalPtyId !== session.terminal.terminalPtyId
    ) {
      throw new Error('controlled Codex terminal identity changed')
    }
    return current
  }

  async disposeConversation(conversationId: string): Promise<void> {
    const session = this.sessions.get(conversationId)
    if (!session) {
      return
    }
    session.client.close()
    if (!session.terminalClosed) {
      await this.options.closeVisibleTerminal(session.terminal)
      session.terminalClosed = true
    }
    await stopControlledCodexServer(session.server, session.socketPath)
    this.sessions.delete(conversationId)
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.disposeConversation(id)))
  }

  getConversationForPane(paneKey: string): string | null {
    for (const session of this.sessions.values()) {
      if (session.terminal.terminalPaneKey === paneKey && !session.missing) {
        return session.launch.conversationId
      }
    }
    return null
  }

  private async connect(
    input: CodexControlledSessionLaunch,
    socketPath: string
  ): Promise<CodexUnixAppServerClient> {
    const client = await CodexUnixAppServerClient.connect(socketPath)
    assertControlledServerIdentity(client.initializeResult, input.codexHome)
    return client
  }

  private async createReadyTerminal(
    input: CodexControlledSessionLaunch,
    socketPath: string,
    command: ReturnType<typeof resolveControlledCodexCommand>,
    onCreated: (identity: CodexControlledSessionIdentity) => void
  ): Promise<CodexControlledSessionIdentity> {
    const terminal = await this.options.createVisibleTerminal({
      worktreeSelector: input.worktreeSelector,
      command: buildControlledVisibleResumeCommand(input, socketPath, command),
      cwd: input.cwd,
      env: { CODEX_HOME: input.codexHome },
      conversationId: input.conversationId,
      threadId: input.threadId,
      presentation: 'focused'
    })
    if (terminal.surface !== 'visible') {
      throw new Error('controlled Codex visible terminal was not renderer-adopted')
    }
    const identity: CodexControlledSessionIdentity = {
      conversationId: input.conversationId,
      threadId: input.threadId,
      terminalHandle: terminal.handle,
      terminalPtyId: terminal.ptyId ?? null,
      terminalTabId: terminal.tabId ?? failControlledTerminalIdentity('tab'),
      terminalPaneKey: terminal.paneKey ?? failControlledTerminalIdentity('pane'),
      worktreeId: terminal.worktreeId ?? failControlledTerminalIdentity('workspace')
    }
    onCreated(identity)
    return this.options.waitForVisibleTerminal(identity)
  }

  private async rollbackFailedLaunch(
    launch: CodexControlledSessionLaunch,
    socketPath: string,
    server: ControlledCodexServer,
    client: CodexUnixAppServerClient | null,
    terminal: CodexControlledSessionIdentity | null
  ): Promise<void> {
    if (!client || !terminal) {
      await stopControlledCodexServer(server, socketPath)
      return
    }
    const session = this.createSession(launch, socketPath, server, client, terminal)
    this.sessions.set(launch.conversationId, session)
    await this.disposeConversation(launch.conversationId)
  }

  private createSession(
    launch: CodexControlledSessionLaunch,
    socketPath: string,
    server: ControlledCodexServer,
    client: CodexUnixAppServerClient,
    terminal: CodexControlledSessionIdentity
  ): ControlledCodexSession {
    const session: ControlledCodexSession = {
      launch,
      socketPath,
      server,
      client,
      terminal,
      state: new CodexControlledSessionStateStore(
        getControlledStatePath(this.options.stateRoot, launch.conversationId),
        {
          conversationId: launch.conversationId,
          threadId: launch.threadId,
          accountId: launch.accountId,
          launchFingerprint: getControlledLaunchFingerprint(launch)
        }
      ),
      missing: false,
      terminalClosed: false
    }
    client.onNotification((method, params) => this.onNotification(session, method, params))
    server.process.once('exit', () => {
      session.missing = true
      this.onMissing(launch.conversationId)
    })
    return session
  }

  private async submitInitialPromptIfPresent(
    session: ControlledCodexSession,
    input: CodexControlledNewSessionLaunch
  ): Promise<void> {
    if (input.prompt?.trim()) {
      await submitControlledInitialTurn(session, input.operationId, input.prompt, () =>
        this.assertCanSubmit(session)
      )
    }
  }

  private assertNewLaunchMatches(
    existing: CodexControlledSessionLaunch,
    input: CodexControlledNewSessionLaunch
  ): void {
    if (!isSameControlledLaunch(existing, { ...input, threadId: existing.threadId })) {
      throw new Error('controlled Codex conversation identity mismatch')
    }
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
