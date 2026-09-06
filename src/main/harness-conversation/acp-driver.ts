import { randomUUID } from 'node:crypto'
import { Readable, Writable } from 'node:stream'
import {
  ClientSideConnection,
  ndJsonStream,
  type Client,
  type AgentCapabilities,
  type AvailableCommand,
  type SessionConfigOption,
  type SessionModeState,
  type SessionNotification
} from '@agentclientprotocol/sdk'
import type { HarnessConversationDriver } from './driver'
import { harnessProcessInvocation } from './harness-process-invocation'
import { acpConversationConfiguration } from './acp-session-configuration'
import type { SessionOptionValue } from '../../shared/native-chat-session-options'
import { startAcpSession } from './acp-session-start'
import * as acpMessage from './acp-message'
import { AcpPermissionController } from './acp-permission-controller'
import { GrokSteerController } from './grok-steer-controller'
import { closeAcpConversationProcess } from './acp-process-close'
import { acpUserPrompt } from './acp-user-prompt'
import { observeGrokResponseBoundary } from './grok-response-boundary'
import type { AcpDriverOptions } from './acp-driver-options'
import { spawnProcess } from '../../shared/child-process/run-process'

export class AcpConversationDriver implements HarnessConversationDriver {
  private readonly child: ReturnType<typeof spawnProcess>
  private readonly connection: ClientSideConnection
  private readonly permissions: AcpPermissionController
  private readonly steers: GrokSteerController
  private readonly texts = new Map<string, { role: 'assistant' | 'reasoning'; text: string }>()
  private readonly tools: acpMessage.AcpToolState = new Map()
  private sessionId: string | null
  private initialized: Promise<void>
  private capabilities: AgentCapabilities = {}
  private commands: AvailableCommand[] = []
  private configOptions: SessionConfigOption[] = []
  private modes: SessionModeState | null = null
  private fallbackMessageId: string = randomUUID()
  private initializing = true

  constructor(private readonly options: AcpDriverOptions) {
    this.sessionId = options.providerSessionId
    this.permissions = new AcpPermissionController(options.sink)
    const invocation = harnessProcessInvocation(options.command, options.args, options.env)
    this.child = spawnProcess({
      program: invocation.command,
      args: invocation.args,
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    if (this.child.pid !== undefined) {
      this.options.sink.setProcessId?.(this.child.pid)
    }
    this.child.once('exit', (code, signal) => {
      this.options.sink.end?.(
        code === 0 ? 'requested-close' : `provider exited (${code ?? signal ?? 'unknown'})`
      )
    })
    this.child.stderr.on('data', () => undefined)
    const client: Client = {
      requestPermission: (request) => this.permissions.request(request),
      sessionUpdate: (notification) => this.sessionUpdate(notification),
      extNotification: (method, params) => {
        if (!this.initializing) {
          this.fallbackMessageId = observeGrokResponseBoundary(
            method,
            params,
            this.sessionId,
            this.options.sink,
            this.texts,
            this.fallbackMessageId
          )
        }
        this.steers.observeNotification(method, params, this.sessionId)
      }
    }
    this.connection = new ClientSideConnection(
      () => client,
      ndJsonStream(
        Writable.toWeb(this.child.stdin) as WritableStream<Uint8Array>,
        Readable.toWeb(this.child.stdout) as ReadableStream<Uint8Array>
      )
    )
    this.steers = new GrokSteerController(
      (method, params) => this.connection.request<{ status?: unknown }>(method, params),
      () => this.publishConfiguration()
    )
    this.initialized = this.initialize()
  }

  ready = (): Promise<void> => this.initialized

  async send(
    text: string,
    imagePaths?: readonly string[],
    submission?: Parameters<HarnessConversationDriver['send']>[2]
  ): Promise<void> {
    await this.initialized
    if (!this.sessionId) {
      throw new Error('acp_session_unavailable')
    }
    this.fallbackMessageId =
      (submission?.clientMessageId as ReturnType<typeof randomUUID> | undefined) ?? randomUUID()
    try {
      const completion = this.connection.prompt({
        sessionId: this.sessionId,
        prompt: acpUserPrompt(text, imagePaths)
      })
      submission?.accepted()
      const response = await completion
      if (response.stopReason === 'cancelled') {
        acpMessage.completeAcpReasoning(this.options.sink, this.texts)
        acpMessage.flushAcpAssistantCommentary(this.options.sink, this.texts)
        throw new Error('turn_interrupted')
      }
      acpMessage.completeAcpReasoning(this.options.sink, this.texts)
      if (response.stopReason === 'end_turn') {
        acpMessage.completeAcpResponse(this.options.sink, this.texts, this.fallbackMessageId)
      } else {
        acpMessage.flushAcpAssistantCommentary(this.options.sink, this.texts)
      }
    } catch (error) {
      acpMessage.completeAcpReasoning(this.options.sink, this.texts)
      acpMessage.flushAcpAssistantCommentary(this.options.sink, this.texts)
      throw error
    } finally {
      this.texts.clear()
      this.tools.clear()
    }
  }

  async interrupt(): Promise<void> {
    await this.initialized
    try {
      if (this.sessionId) {
        await this.connection.cancel({ sessionId: this.sessionId })
      }
    } finally {
      this.permissions.cancel()
      this.steers.rejectAll()
    }
  }

  async steer(
    text: string,
    imagePaths: readonly string[] | undefined,
    clientMessageId: string,
    accept: Parameters<NonNullable<HarnessConversationDriver['steer']>>[3]
  ): Promise<void> {
    await this.initialized
    if (!this.sessionId) {
      throw new Error('conversation_not_working')
    }
    return this.steers.steer(this.sessionId, text, imagePaths, clientMessageId, accept)
  }

  answerPermission = (requestId: string, optionId: string): void =>
    this.permissions.answer(requestId, optionId)

  answerInput(): void {}

  async setOption(optionId: string, value: SessionOptionValue): Promise<void> {
    await this.initialized
    if (!this.sessionId) {
      throw new Error('acp_session_unavailable')
    }
    if (optionId === 'mode') {
      if (typeof value !== 'string') {
        throw new Error('conversation_option_invalid')
      }
      await this.connection.setSessionMode({ sessionId: this.sessionId, modeId: value })
      if (this.modes) {
        this.modes = { ...this.modes, currentModeId: value }
      }
    } else {
      const response = await this.connection.setSessionConfigOption(
        typeof value === 'boolean'
          ? {
              sessionId: this.sessionId,
              configId: optionId,
              type: 'boolean',
              value
            }
          : { sessionId: this.sessionId, configId: optionId, value }
      )
      this.configOptions = response.configOptions
    }
    this.publishConfiguration()
  }

  async compact(): Promise<void> {
    if (!this.commands.some((command) => command.name === 'compact')) {
      throw new Error('conversation_compact_unsupported')
    }
    await this.send('/compact')
  }

  async close(): Promise<void> {
    this.permissions.cancel()
    this.steers.rejectAll()
    await closeAcpConversationProcess(
      this.connection,
      this.child,
      this.sessionId,
      Boolean(this.capabilities.sessionCapabilities?.close)
    )
  }

  private async initialize(): Promise<void> {
    try {
      const result = await startAcpSession({
        connection: this.connection,
        cwd: this.options.cwd,
        providerSessionId: this.sessionId,
        forkFromProviderSessionId: this.options.forkFromProviderSessionId
      })
      this.capabilities = result.capabilities
      this.sessionId = result.sessionId
      this.modes = result.modes
      this.configOptions = result.configOptions
      this.options.sink.setProviderSessionId(result.sessionId)
      this.publishConfiguration()
    } finally {
      this.initializing = false
    }
  }

  private async sessionUpdate(notification: SessionNotification): Promise<void> {
    await this.steers.observeTurn(notification)
    const update = notification.update
    if (
      update.sessionUpdate === 'agent_message_chunk' ||
      update.sessionUpdate === 'agent_thought_chunk'
    ) {
      if (this.initializing) {
        return
      }
      acpMessage.emitAcpTextChunk(this.options.sink, this.texts, update, this.fallbackMessageId)
      return
    }
    if (update.sessionUpdate === 'tool_call') {
      if (this.initializing) {
        return
      }
      acpMessage.flushAcpAssistantCommentary(this.options.sink, this.texts)
      this.fallbackMessageId = randomUUID()
      this.tools.set(update.toolCallId, {
        name: update.name ?? update.title,
        input: update.rawInput
      })
      acpMessage.emitAcpTool(this.options.sink, this.tools, update.toolCallId)
      return
    }
    if (update.sessionUpdate === 'tool_call_update') {
      if (this.initializing) {
        return
      }
      if (!this.tools.has(update.toolCallId)) {
        acpMessage.flushAcpAssistantCommentary(this.options.sink, this.texts)
        this.fallbackMessageId = randomUUID()
      }
      const current = this.tools.get(update.toolCallId) ?? {
        name: update.name ?? update.title ?? 'Tool',
        input: update.rawInput
      }
      this.tools.set(update.toolCallId, {
        name: update.name ?? update.title ?? current.name,
        input: update.rawInput ?? current.input,
        output: update.rawOutput ?? update.content ?? current.output,
        failed: update.status === 'failed'
      })
      acpMessage.emitAcpTool(this.options.sink, this.tools, update.toolCallId)
      return
    }
    if (update.sessionUpdate === 'plan') {
      if (!this.initializing) {
        this.options.sink.emit({
          type: 'message.completed',
          message: acpMessage.acpPlanMessage(update, this.fallbackMessageId)
        })
      }
      return
    }
    if (update.sessionUpdate === 'usage_update') {
      this.options.sink.setContext(acpMessage.acpUsageContext(update))
      return
    }
    if (update.sessionUpdate === 'available_commands_update') {
      this.commands = update.availableCommands
      this.publishConfiguration()
    } else if (update.sessionUpdate === 'current_mode_update' && this.modes) {
      this.modes = { ...this.modes, currentModeId: update.currentModeId }
      this.publishConfiguration()
    } else if (update.sessionUpdate === 'config_option_update') {
      this.configOptions = update.configOptions
      this.publishConfiguration()
    }
  }

  private publishConfiguration(): void {
    this.options.sink.setConfiguration({
      ...acpConversationConfiguration({
        commands: this.commands,
        configOptions: this.configOptions,
        modes: this.modes,
        canFork: Boolean(this.capabilities.sessionCapabilities?.fork)
      }),
      canSteer: this.steers.supported
    })
  }
}
