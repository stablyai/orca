import type { CodexUnixAppServerClient } from './codex-unix-app-server-client'
import { CodexControlledSessionDisposalFence } from './codex-controlled-session-disposal-fence'
import {
  assertControlledThreadAlive,
  buildControlledThreadResumeParams,
  buildControlledThreadStartParams,
  controlledLaunchOutcomeUnknown,
  extractControlledThreadId,
  getControlledSocketPath,
  isSameControlledLaunch,
  resolveControlledCodexCommand,
  startControlledCodexServer,
  stopControlledCodexServer,
  type ControlledCodexCommand,
  type ControlledCodexServer,
  type CodexControlledSessionLaunch
} from './codex-controlled-session-launch'
import {
  connectControlledCodexClient,
  createControlledCodexSession,
  createReadyControlledTerminal,
  submitControlledInitialPrompt,
  type ControlledCodexSession
} from './codex-controlled-session-acquisition'
import type {
  CodexControlledNewSessionLaunch,
  CodexControlledSessionIdentity,
  CodexControlledSessionLaunchResult,
  CodexControlledSessionManagerOptions
} from './codex-controlled-session-manager'

export type { ControlledCodexSession } from './codex-controlled-session-acquisition'
export class CodexControlledSessionRegistry {
  private readonly sessions = new Map<string, ControlledCodexSession>()
  private readonly launches = new Map<string, Promise<unknown>>()
  private readonly disposalFence = new CodexControlledSessionDisposalFence(
    (conversationId) => this.launches.get(conversationId),
    () => new Set([...this.sessions.keys(), ...this.launches.keys()]),
    (conversationId) => this.disposeSession(conversationId)
  )

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
    return this.trackLaunch(input.conversationId, () => this.launchExistingThread(input))
  }
  private async launchExistingThread(
    input: CodexControlledSessionLaunch
  ): Promise<CodexControlledSessionLaunchResult> {
    const existing = this.sessions.get(input.conversationId)
    if (existing) {
      if (!isSameControlledLaunch(existing.launch, input)) {
        throw new Error('controlled Codex conversation identity mismatch')
      }
      if (existing.missing) {
        throw new Error('controlled Codex conversation requires cleanup before relaunch')
      }
      existing.terminal = await this.refresh(existing)
      this.assertLaunchPermitted(existing.launch)
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
      this.assertLaunchPermitted(input)
      client = await connectControlledCodexClient(input, socketPath)
      this.assertLaunchPermitted(input)
      await client.request('thread/resume', buildControlledThreadResumeParams(input))
      this.assertLaunchPermitted(input)
      visibleIdentity = await createReadyControlledTerminal(
        this.options,
        input,
        socketPath,
        command,
        (created) => {
          visibleIdentity = created
        }
      )
      await assertControlledThreadAlive(client, input.threadId)
      this.assertLaunchPermitted(input)
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
    return this.trackLaunch(input.conversationId, () => this.launchNewThread(input, command))
  }
  private async launchNewThread(
    input: CodexControlledNewSessionLaunch,
    command: ControlledCodexCommand
  ): Promise<CodexControlledSessionLaunchResult> {
    const existing = this.sessions.get(input.conversationId)
    if (existing) {
      this.assertNewLaunchMatches(existing.launch, input)
      if (existing.missing) {
        throw new Error('controlled Codex conversation requires cleanup before relaunch')
      }
      existing.terminal = await this.refresh(existing)
      this.assertLaunchPermitted(existing.launch)
      await submitControlledInitialPrompt(existing, input, this.assertCanSubmit)
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
      this.assertLaunchPermitted(provisional)
      client = await connectControlledCodexClient(provisional, socketPath)
      this.assertLaunchPermitted(provisional)
      threadStartAttempted = true
      const started = await client.request(
        'thread/start',
        buildControlledThreadStartParams(provisional)
      )
      launch = { ...input, threadId: extractControlledThreadId(started) }
      this.assertLaunchPermitted(launch)
      identity = await createReadyControlledTerminal(
        this.options,
        launch,
        socketPath,
        command,
        (created) => {
          identity = created
        }
      )
      await assertControlledThreadAlive(client, launch.threadId)
      this.assertLaunchPermitted(launch)
      const session = this.createSession(launch, socketPath, server, client, identity)
      this.sessions.set(input.conversationId, session)
      await submitControlledInitialPrompt(session, input, this.assertCanSubmit)
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
    return this.disposalFence.disposeConversation(conversationId)
  }

  private async disposeSession(conversationId: string): Promise<void> {
    const session = this.sessions.get(conversationId)
    if (!session) {
      return
    }
    session.missing = true
    session.client.close()
    if (!session.terminalClosed) {
      await this.options.closeVisibleTerminal(session.terminal)
      session.terminalClosed = true
    }
    await stopControlledCodexServer(session.server, session.socketPath)
    this.sessions.delete(conversationId)
  }

  async dispose(): Promise<void> {
    await this.disposalFence.dispose()
  }

  getConversationForPane(paneKey: string): string | null {
    for (const session of this.sessions.values()) {
      if (session.terminal.terminalPaneKey === paneKey && !session.missing) {
        return session.launch.conversationId
      }
    }
    return null
  }

  private async rollbackFailedLaunch(
    launch: CodexControlledSessionLaunch,
    socketPath: string,
    server: ControlledCodexServer,
    client: CodexUnixAppServerClient | null,
    terminal: CodexControlledSessionIdentity | null
  ): Promise<void> {
    if (!client || !terminal) {
      client?.close()
      await stopControlledCodexServer(server, socketPath)
      return
    }
    const session = this.createSession(launch, socketPath, server, client, terminal)
    this.sessions.set(launch.conversationId, session)
    await this.disposeSession(launch.conversationId)
  }

  private createSession(
    launch: CodexControlledSessionLaunch,
    socketPath: string,
    server: ControlledCodexServer,
    client: CodexUnixAppServerClient,
    terminal: CodexControlledSessionIdentity
  ): ControlledCodexSession {
    return createControlledCodexSession({
      options: this.options,
      launch,
      socketPath,
      server,
      client,
      terminal,
      onNotification: this.onNotification,
      onMissing: this.onMissing
    })
  }

  private assertNewLaunchMatches(
    existing: CodexControlledSessionLaunch,
    input: CodexControlledNewSessionLaunch
  ): void {
    if (!isSameControlledLaunch(existing, { ...input, threadId: existing.threadId })) {
      throw new Error('controlled Codex conversation identity mismatch')
    }
  }

  private async trackLaunch<T>(conversationId: string, start: () => Promise<T>): Promise<T> {
    this.assertNotDisposing(conversationId)
    const active = this.launches.get(conversationId)
    if (active) {
      await active.catch(() => {})
      return this.trackLaunch(conversationId, start)
    }
    const launch = start()
    this.launches.set(conversationId, launch)
    try {
      return await launch
    } finally {
      if (this.launches.get(conversationId) === launch) {
        this.launches.delete(conversationId)
      }
    }
  }

  private assertLaunchPermitted(input: CodexControlledSessionLaunch): void {
    this.assertNotDisposing(input.conversationId)
    this.assertCanLaunch(input)
  }

  private assertNotDisposing(conversationId: string): void {
    this.disposalFence.assertNotDisposing(conversationId)
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
