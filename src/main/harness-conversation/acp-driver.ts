import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { Readable, Writable } from 'node:stream'
import { basename } from 'node:path'
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
import type { HarnessConversationDriver, HarnessConversationDriverSink } from './driver'
import { killCodexAppServerProcessTree } from '../codex/codex-app-server-session'
import { waitForProcessExitUntil } from '../codex/codex-process-exit-deadline'
import { harnessProcessInvocation } from './harness-process-invocation'
import { providerAttachmentUri } from './provider-image-input'
import { acpConversationConfiguration } from './acp-session-configuration'
import type { SessionOptionValue } from '../../shared/native-chat-session-options'
import { startAcpSession } from './acp-session-start'
import {
  acpPlanMessage,
  acpToolMessage,
  acpUsageContext,
  completeAcpReasoning,
  emitAcpFinal,
  emitAcpTextChunk,
  flushAcpAssistantCommentary
} from './acp-message'
import { AcpPermissionController } from './acp-permission-controller'

type AcpDriverOptions = {
  cwd: string
  providerSessionId: string | null
  forkFromProviderSessionId: string | null
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
  sink: HarnessConversationDriverSink
}

export class AcpConversationDriver implements HarnessConversationDriver {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly connection: ClientSideConnection
  private readonly permissions: AcpPermissionController
  private readonly texts = new Map<string, { role: 'assistant' | 'reasoning'; text: string }>()
  private readonly tools = new Map<
    string,
    { name: string; input: unknown; output?: unknown; failed?: boolean }
  >()
  private sessionId: string | null
  private initialized: Promise<void>
  private capabilities: AgentCapabilities = {}
  private commands: AvailableCommand[] = []
  private configOptions: SessionConfigOption[] = []
  private modes: SessionModeState | null = null
  private fallbackMessageId = randomUUID()
  private initializing = true

  constructor(private readonly options: AcpDriverOptions) {
    this.sessionId = options.providerSessionId
    this.permissions = new AcpPermissionController(options.sink)
    const invocation = harnessProcessInvocation(options.command, options.args, options.env)
    this.child = spawn(invocation.command, invocation.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
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
      sessionUpdate: (notification) => this.sessionUpdate(notification)
    }
    this.connection = new ClientSideConnection(
      () => client,
      ndJsonStream(
        Writable.toWeb(this.child.stdin) as WritableStream<Uint8Array>,
        Readable.toWeb(this.child.stdout) as ReadableStream<Uint8Array>
      )
    )
    this.initialized = this.initialize()
  }

  ready(): Promise<void> {
    return this.initialized
  }

  async send(text: string, imagePaths?: readonly string[]): Promise<void> {
    await this.initialized
    if (!this.sessionId) {
      throw new Error('acp_session_unavailable')
    }
    this.fallbackMessageId = randomUUID()
    try {
      const response = await this.connection.prompt({
        sessionId: this.sessionId,
        prompt: [
          ...(text ? [{ type: 'text' as const, text }] : []),
          ...(imagePaths ?? []).map((path) => ({
            type: 'resource_link' as const,
            uri: providerAttachmentUri(path),
            name: basename(path)
          }))
        ]
      })
      if (response.stopReason === 'cancelled') {
        completeAcpReasoning(this.options.sink, this.texts)
        flushAcpAssistantCommentary(this.options.sink, this.texts)
        throw new Error('turn_interrupted')
      }
      completeAcpReasoning(this.options.sink, this.texts)
      if (response.stopReason === 'end_turn') {
        emitAcpFinal(this.options.sink, this.texts)
      } else {
        flushAcpAssistantCommentary(this.options.sink, this.texts)
      }
    } catch (error) {
      completeAcpReasoning(this.options.sink, this.texts)
      flushAcpAssistantCommentary(this.options.sink, this.texts)
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
    }
  }

  answerPermission(requestId: string, optionId: string): void {
    this.permissions.answer(requestId, optionId)
  }

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
    try {
      if (this.sessionId && this.capabilities.sessionCapabilities?.close) {
        await waitForProcessExitUntil(
          this.connection.closeSession({ sessionId: this.sessionId }).then(() => undefined),
          1_000
        )
      }
    } finally {
      this.child.kill('SIGTERM')
      await waitForProcessExitUntil(
        this.connection.closed.catch(() => undefined),
        1_000
      )
      if (this.child.exitCode === null) {
        killCodexAppServerProcessTree(this.child)
      }
    }
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

  private sessionUpdate(notification: SessionNotification): void {
    const update = notification.update
    if (
      update.sessionUpdate === 'agent_message_chunk' ||
      update.sessionUpdate === 'agent_thought_chunk'
    ) {
      if (this.initializing) {
        return
      }
      emitAcpTextChunk(this.options.sink, this.texts, update, this.fallbackMessageId)
      return
    }
    if (update.sessionUpdate === 'tool_call') {
      if (this.initializing) {
        return
      }
      flushAcpAssistantCommentary(this.options.sink, this.texts)
      this.fallbackMessageId = randomUUID()
      this.tools.set(update.toolCallId, {
        name: update.name ?? update.title,
        input: update.rawInput
      })
      this.emitTool(update.toolCallId)
      return
    }
    if (update.sessionUpdate === 'tool_call_update') {
      if (this.initializing) {
        return
      }
      if (!this.tools.has(update.toolCallId)) {
        flushAcpAssistantCommentary(this.options.sink, this.texts)
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
      this.emitTool(update.toolCallId)
      return
    }
    if (update.sessionUpdate === 'plan') {
      if (!this.initializing) {
        this.options.sink.emit({
          type: 'message.completed',
          message: acpPlanMessage(update, this.fallbackMessageId)
        })
      }
      return
    }
    if (update.sessionUpdate === 'usage_update') {
      this.options.sink.setContext(acpUsageContext(update))
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
    this.options.sink.setConfiguration(
      acpConversationConfiguration({
        commands: this.commands,
        configOptions: this.configOptions,
        modes: this.modes,
        canFork: Boolean(this.capabilities.sessionCapabilities?.fork)
      })
    )
  }

  private emitTool(toolCallId: string): void {
    const tool = this.tools.get(toolCallId)
    if (!tool) {
      return
    }
    this.options.sink.emit({
      type: 'message.completed',
      message: acpToolMessage(toolCallId, tool)
    })
  }
}
