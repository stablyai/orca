import type { TraexSessionDeps, TraexPendingSend } from './traex-session-contract'
export type { TraexSessionDeps, TraexPendingSend } from './traex-session-contract'
import { randomUUID } from 'node:crypto'
import type { StructuredAgentSessionAcquireInput } from '../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import { readTraexSessionOptions, selectTraexSessionOption } from './traex-session-options'
import type { StructuredAgentSessionProviderOpenResult } from '../native-chat/agent-session-wire/startup/structured-agent-session-provider-open-contract'
import {
  TraexAppServerConnection,
  type TraexServerRequest,
  type TraexConnectionHandlers
} from './traex-app-server-connection'
import type { TraexLaunch } from './traex-launch-resolution'
import { TraexTimeline } from './traex-timeline'
import { TraexPromptRegistry } from './traex-prompt-registry'
import type { TraexModel } from './traex-model-catalog'
import { traexRecord, traexText } from './traex-protocol'
import type {
  AgentSessionModelOption,
  AgentSessionSlashCommand
} from '../../shared/agent-session/agent-session-wire'
import type { AgentSessionOptionsResult } from '../../shared/agent-session/options/agent-session-options-result'
import { openTraexSession } from './traex-session-start'
import { readTraexSessionCommands } from './traex-session-commands'
import { TraexChildWork } from './traex-child-work'
import { observeTraexSessionNotification } from './traex-session-notifications'

export class TraexSession {
  readonly generation = randomUUID()
  readonly connection: TraexAppServerConnection
  readonly pending = new Map<string, TraexPendingSend>()
  readonly options: Record<string, string>
  nativeModels: TraexModel[] = []
  models: AgentSessionModelOption[] = []
  threadId: string | null = null
  historyMode: string | null = null
  rewindUnsupported = false
  interactionModeSupported = false
  commands: AgentSessionSlashCommand[] | undefined
  commandsRead: Promise<void> | null = null
  activeTurn: string | null = null
  compacting = false
  ranOptions: Record<string, string> = {}
  reportedPermissionMode: string | null = null
  reportedModel: string | undefined
  timeline: TraexTimeline | null = null
  prompts: TraexPromptRegistry | null = null
  childWork: TraexChildWork | null = null
  readonly childThreads = new Map<
    string,
    { timeline: TraexTimeline; prompts: TraexPromptRegistry; turnId: string | null }
  >()
  private childWrites: Promise<void> = Promise.resolve()
  requestedClose = false
  ended = false
  failure: Error | null = null
  private readonly early: { method: string; params: unknown }[] = []
  private opening = true
  private startupBytes = 0
  private openingWork: Promise<StructuredAgentSessionProviderOpenResult> | null = null
  private unbindReading: (() => void) | undefined
  private exitWork: Promise<void> = Promise.resolve()
  private readonly completedTurns = new Set<string>()

  constructor(
    readonly input: StructuredAgentSessionAcquireInput,
    readonly launch: TraexLaunch,
    private readonly deps: TraexSessionDeps
  ) {
    this.options = { ...launch.options }
    const handlers: TraexConnectionHandlers = {
      onNotification: (method, params) => this.notification(method, params),
      onRequest: (request) => this.request(request),
      onProtocolFailure: (error) => {
        this.failure = error
      },
      onExit: (error) => this.exited(error)
    }
    this.connection =
      deps.connect?.(launch, handlers) ?? new TraexAppServerConnection(launch, handlers)
  }

  open(signal: AbortSignal): Promise<StructuredAgentSessionProviderOpenResult> {
    this.openingWork ??= openTraexSession(this, signal, this.deps.logger)
    return this.openingWork
  }

  refreshCommands(forceReload = false): Promise<void> {
    this.commandsRead ??= readTraexSessionCommands(this.connection, this.launch.cwd, forceReload)
      .then((commands) => {
        this.commands = commands
        this.input.events?.publish()
      })
      .finally(() => {
        this.commandsRead = null
      })
    return this.commandsRead
  }

  bindThread(threadId: string): void {
    const sink = this.input.events
    if (!sink) {
      throw new Error('TRAE CLI chats require a journal sink')
    }
    this.timeline = new TraexTimeline({
      sessionId: this.input.identity.sessionId,
      threadId,
      generation: this.generation,
      sink,
      fail: (error) => this.fail(error)
    })
    this.childWork = new TraexChildWork(threadId)
    this.prompts = new TraexPromptRegistry(this.connection, this.timeline, threadId, (mode) =>
      this.updateMode(mode)
    )
    this.unbindReading = sink.bindReadingControl?.({
      pauseReading: () => this.connection.pauseReading(),
      resumeReading: () => {
        this.connection.resumeReading()
        this.timeline?.retry()
      }
    })
  }

  finishStartup(): void {
    this.opening = false
    this.startupBytes = 0
    for (const frame of this.early.splice(0)) {
      this.notification(frame.method, frame.params)
    }
  }

  accept(send: TraexPendingSend, turnId: string): void {
    if (!this.timeline || send.turnId) {
      return
    }
    send.turnId = turnId
    this.timeline.apply({
      type: 'input.accepted',
      clientMessageId: send.clientMessageId,
      requestedAt: send.requestedAt,
      join: { thread: this.threadId!, turn: turnId }
    })
    if (!this.completedTurns.has(turnId)) {
      this.activeTurn = turnId
      this.timeline.apply({ type: 'turn.open', turn: turnId, at: Date.now() })
    }
    this.pending.delete(send.clientMessageId)
    this.publishChildEvidence([{ type: 'turn-started', observedAt: Date.now() }])
    if (send.unknown) {
      this.deps.onSettled(send.clientMessageId, {
        provider: 'orca',
        clientMessageId: send.clientMessageId
      })
    }
  }

  readOptions = (): AgentSessionOptionsResult => readTraexSessionOptions(this)
  setOption = (key: string, value: string, signal?: AbortSignal): Promise<void> =>
    selectTraexSessionOption(this, key, value, signal)

  notification(method: string, value: unknown): void {
    if (this.ended) {
      return
    }
    if (this.opening) {
      this.startupBytes += Buffer.byteLength(JSON.stringify(value ?? null), 'utf8')
      if (this.early.length >= 512 || this.startupBytes > 32 * 1024 * 1024) {
        this.fail(new Error('TRAE CLI startup notification backlog overflowed'))
      } else {
        this.early.push({ method, params: value })
      }
      return
    }
    observeTraexSessionNotification(this, method, value, this.deps.logger)
  }

  async updateMode(mode: 'plan' | 'default'): Promise<void> {
    if (this.ended) {
      return
    }
    this.options.interactionMode = mode
    this.ranOptions.interactionMode = mode
    await this.deps.onModeChanged?.(this.input.identity.sessionId, this.input.fence, mode)
    this.input.events?.publish()
  }

  noteCompletedTurn(turnId: string): void {
    this.completedTurns.add(turnId)
    if (this.completedTurns.size > 256) {
      this.completedTurns.delete(this.completedTurns.values().next().value!)
    }
  }

  promptOwner(itemId: string): TraexPromptRegistry {
    return (
      [...this.childThreads.values()].find((child) => child.prompts.has(itemId))?.prompts ??
      this.prompts!
    )
  }

  publishChildEvidence(evidence = this.childWork?.drain() ?? []): void {
    if (!evidence.length) {
      return
    }
    this.childWrites = this.childWrites
      .then(async () => {
        const written = await this.input.events?.written?.()
        if (written && !written.ok) {
          throw written.error
        }
        this.deps.onChildWorkEvidence?.(this.input.identity.sessionId, evidence, this.input.events)
      })
      .catch((error: unknown) =>
        this.fail(error instanceof Error ? error : new Error(String(error)))
      )
  }

  finishCompaction(failed = false): void {
    this.timeline?.apply(
      {
        type: 'turn.end',
        at: Date.now(),
        state: 'completed',
        outcome: failed ? 'failure' : 'success',
        ...(this.activeTurn ? { providerTurnId: this.activeTurn } : {})
      },
      () => {
        this.compacting = false
        this.activeTurn = null
      }
    )
  }

  private request(request: TraexServerRequest): void {
    try {
      if (!this.prompts || this.requestedClose) {
        this.connection.reject(request.id, 'TRAE CLI session is not ready for prompts')
      } else {
        const threadId = traexText(traexRecord(request.params).threadId)
        const child = threadId && this.childThreads.get(threadId)
        ;(child ? child.prompts : this.prompts).handle(
          request,
          child ? child.turnId : this.activeTurn
        )
      }
    } catch (error) {
      this.connection.reject(
        request.id,
        error instanceof Error ? error.message : 'TRAE CLI prompt could not be rendered'
      )
    }
  }

  private exited(error: Error): void {
    this.ended = true
    this.failure ??= error
    if (!this.requestedClose) {
      this.input.events?.observeRootExit?.()
    }
    this.timeline?.flush()
    this.childWork?.end()
    this.publishChildEvidence()
    this.timeline?.apply({
      type: 'session.ended',
      verdict: { state: 'interrupted', completedAt: Date.now() },
      endedAt: Date.now()
    })
    this.exitWork = Promise.all([this.childWrites, this.input.events?.written?.()]).then(() => {
      this.deps.onLifecycle({
        type: 'ended',
        sessionId: this.input.identity.sessionId,
        fence: this.input.fence,
        acquisitionGeneration: this.generation,
        reason: error.message,
        cause: this.requestedClose ? 'requested-close' : 'unexpected-exit',
        observedAt: Date.now()
      })
    })
  }

  fail(error: Error): void {
    this.failure ??= error
    void this.connection.close()
  }

  async close(requested = true): Promise<boolean> {
    this.requestedClose ||= requested
    this.prompts?.withdraw()
    this.childThreads.forEach((child) => child.prompts.withdraw())
    const closed = await this.connection.close()
    await this.exitWork
    return closed
  }

  async retire(): Promise<void> {
    await this.exitWork
    this.unbindReading?.()
    this.timeline?.dispose()
    this.childThreads.forEach((child) => child.timeline.dispose())
    this.childThreads.clear()
    this.prompts?.withdraw()
    this.pending.clear()
  }

  drainObservedExit(): Promise<void> {
    return this.exitWork
  }
}
