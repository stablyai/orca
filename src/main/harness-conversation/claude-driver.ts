import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  query,
  type CanUseTool,
  type Query,
  type SDKUserMessage
} from '@anthropic-ai/claude-agent-sdk'
import type { HarnessConversationDriver, HarnessConversationDriverSink } from './driver'
import {
  claudeTextMessage,
  emitClaudeAssistant,
  emitClaudeBufferedCommentary,
  emitClaudeFinal,
  emitClaudeStreamDelta,
  emitClaudeToolResults
} from './claude-message'
import { harnessProcessInvocation } from './harness-process-invocation'
import { providerImageData } from './provider-image-input'
import type { SessionOptionValue } from '../../shared/native-chat-session-options'
import type { StructuredProviderConfiguration } from '../../shared/structured-agent-provider'
import { claudeConversationConfiguration } from './claude-configuration'
import { ClaudeInteractionController } from './claude-interaction-controller'
import { resolveSessionFilePath } from '../native-chat/session-file-resolver'
import { ClaudeConversationActivity } from './claude-activity'
import type { AgentPermissionMode } from '../../shared/tui-agent-permissions'

type ClaudeDriverOptions = {
  cwd: string
  providerSessionId: string | null
  newProviderSessionId?: string
  forkFromProviderSessionId: string | null
  command: string
  commandArgs: string[]
  permissionMode: AgentPermissionMode
  env: NodeJS.ProcessEnv
  sink: HarnessConversationDriverSink
}

export class ClaudeConversationDriver implements HarnessConversationDriver {
  private readonly current: Query
  private sessionId: string | null
  private readonly prompts: SDKUserMessage[] = []
  private readonly promptWaiters: ((message: SDKUserMessage | null) => void)[] = []
  private readonly turns: { resolve: () => void; reject: (error: Error) => void }[] = []
  private readonly interactions: ClaudeInteractionController
  private readonly activity: ClaudeConversationActivity
  private readonly readyPromise: Promise<void>
  private configuration: StructuredProviderConfiguration = {
    commands: [],
    options: [],
    canCompact: false,
    canFork: true
  }
  private closed = false

  constructor(private readonly options: ClaudeDriverOptions) {
    this.sessionId = options.forkFromProviderSessionId ? null : options.providerSessionId
    this.interactions = new ClaudeInteractionController(options.sink)
    this.activity = new ClaudeConversationActivity(options.sink)
    const abortController = new AbortController()
    const canUseTool: CanUseTool = this.interactions.request
    const bypassPermissions = options.permissionMode === 'yolo'
    this.current = query({
      prompt: this.promptStream(),
      options: {
        abortController,
        cwd: this.options.cwd,
        env: this.options.env,
        includePartialMessages: true,
        pathToClaudeCodeExecutable: this.options.command,
        permissionMode: bypassPermissions ? 'bypassPermissions' : 'default',
        allowDangerouslySkipPermissions: bypassPermissions,
        settingSources: ['user', 'project', 'local'],
        canUseTool: bypassPermissions ? undefined : canUseTool,
        ...(options.forkFromProviderSessionId
          ? {
              resume: options.forkFromProviderSessionId,
              forkSession: true,
              ...(options.newProviderSessionId ? { sessionId: options.newProviderSessionId } : {})
            }
          : this.sessionId
            ? { resume: this.sessionId }
            : options.newProviderSessionId
              ? { sessionId: options.newProviderSessionId }
              : {}),
        spawnClaudeCodeProcess: ({ args, cwd, env, signal }) => {
          const invocation = harnessProcessInvocation(
            this.options.command,
            [...this.options.commandArgs, ...args],
            env
          )
          const child = spawn(invocation.command, invocation.args, {
            cwd,
            env,
            signal,
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true
          })
          if (child.pid !== undefined) {
            this.options.sink.setProcessId?.(child.pid)
          }
          child.stderr?.on('data', () => undefined)
          return child as NonNullable<ReturnType<typeof spawn>> & {
            stdin: NonNullable<ReturnType<typeof spawn>['stdin']>
            stdout: NonNullable<ReturnType<typeof spawn>['stdout']>
          }
        }
      }
    })
    this.readyPromise = this.current.initializationResult().then((initialization) => {
      this.configuration = claudeConversationConfiguration(initialization)
      this.options.sink.setConfiguration(this.configuration)
      this.activity.setInitialFastMode(initialization.fast_mode_state)
      if (this.sessionId) {
        void this.publishTranscriptPath(this.sessionId)
      }
    })
    void this.readMessages()
  }

  ready(): Promise<void> {
    return this.readyPromise
  }

  async send(text: string, imagePaths?: readonly string[]): Promise<void> {
    await this.readyPromise
    if (this.closed) {
      throw new Error('claude_session_closed')
    }
    const content: SDKUserMessage['message']['content'] = [
      ...(text ? [{ type: 'text' as const, text }] : []),
      ...(imagePaths ?? []).map((path) => {
        const image = providerImageData(path)
        return {
          type: 'image' as const,
          source: { type: 'base64' as const, media_type: image.mediaType, data: image.data }
        }
      })
    ]
    const message: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      uuid: randomUUID()
    }
    const completion = new Promise<void>((resolve, reject) => this.turns.push({ resolve, reject }))
    this.enqueuePrompt(message)
    return completion
  }

  async setOption(optionId: string, value: SessionOptionValue): Promise<void> {
    await this.readyPromise
    if (typeof value !== 'string') {
      throw new Error('conversation_option_invalid')
    }
    if (optionId === 'model') {
      await this.current.setModel(value)
      this.activity.setModel(value)
    } else if (optionId === 'effort') {
      await this.current.applyFlagSettings({
        effortLevel: value as 'low' | 'medium' | 'high' | 'xhigh' | 'max'
      })
      this.activity.setEffort(value)
    } else {
      throw new Error('conversation_option_unknown')
    }
    this.configuration = {
      ...this.configuration,
      options: this.configuration.options.map((option) =>
        option.id === optionId && option.kind.type === 'select'
          ? { ...option, kind: { ...option.kind, currentValue: value }, valueSource: 'applied' }
          : option
      )
    }
    this.options.sink.setConfiguration(this.configuration)
  }

  compact = (): Promise<void> => this.send('/compact')

  private async readMessages(): Promise<void> {
    let streamingId: string | null = null
    const streamedText = new Map<string, string>()
    try {
      for await (const message of this.current) {
        this.activity.observe(message)
        if (message.session_id && message.session_id !== this.sessionId) {
          this.sessionId = message.session_id
          this.options.sink.setProviderSessionId(message.session_id)
          void this.publishTranscriptPath(message.session_id)
        }
        if (message.type === 'stream_event') {
          const event = message.event as unknown as Record<string, unknown>
          if (event.type === 'message_start') {
            const providerId = (event.message as { id?: unknown } | undefined)?.id
            streamingId = `claude:${typeof providerId === 'string' ? providerId : message.uuid}`
            streamedText.clear()
          } else if (event.type === 'content_block_delta') {
            emitClaudeStreamDelta(this.options.sink, event, message.uuid, streamingId, streamedText)
          }
        } else if (message.type === 'assistant' && message.parent_tool_use_id === null) {
          if (emitClaudeAssistant(this.options.sink, message, streamingId, streamedText)) {
            streamingId = null
          }
        } else if (message.type === 'user' && message.parent_tool_use_id === null) {
          emitClaudeToolResults(this.options.sink, message)
        } else if (message.type === 'system' && message.subtype === 'local_command_output') {
          this.options.sink.emit({
            type: 'message.completed',
            message: claudeTextMessage(
              `claude:${message.uuid}`,
              'assistant',
              message.content,
              'final'
            )
          })
        } else if (message.type === 'system' && message.subtype === 'informational') {
          this.options.sink.emit({
            type: 'message.completed',
            message: claudeTextMessage(`claude:${message.uuid}`, 'system', message.content)
          })
        } else if (message.type === 'system' && message.subtype === 'commands_changed') {
          this.configuration = {
            ...this.configuration,
            commands: message.commands.map((command) => ({
              name: command.name,
              description: command.description,
              inputHint: command.argumentHint
            })),
            canCompact: message.commands.some((command) => command.name === 'compact')
          }
          this.options.sink.setConfiguration(this.configuration)
        } else if (message.type === 'result' && message.is_error) {
          void this.publishCurrentTranscriptPath()
          emitClaudeBufferedCommentary(this.options.sink, streamedText)
          const failure =
            'result' in message && typeof message.result === 'string'
              ? message.result
              : message.subtype
          this.turns.shift()?.reject(new Error(failure))
          streamedText.clear()
          streamingId = null
        } else if (message.type === 'result') {
          void this.publishCurrentTranscriptPath()
          emitClaudeFinal(
            this.options.sink,
            streamingId ?? `claude:${message.uuid}`,
            'result' in message ? message.result : ''
          )
          this.turns.shift()?.resolve()
          streamedText.clear()
          streamingId = null
        }
      }
    } catch (error) {
      emitClaudeBufferedCommentary(this.options.sink, streamedText)
      this.rejectTurns(error)
    } finally {
      this.rejectTurns(new Error('claude_session_closed'))
      this.options.sink.end?.(this.closed ? 'requested-close' : 'provider stream ended')
    }
  }

  async interrupt(): Promise<void> {
    try {
      await this.current.interrupt()
    } finally {
      this.interactions.cancel()
    }
  }

  answerPermission(requestId: string, optionId: string): void {
    this.interactions.answerPermission(requestId, optionId)
  }

  answerInput(requestId: string, answers: Record<string, string[]>): void {
    this.interactions.answerInput(requestId, answers)
  }

  async close(): Promise<void> {
    this.closed = true
    for (const waiter of this.promptWaiters.splice(0)) {
      waiter(null)
    }
    this.current.close()
    this.interactions.cancel()
    this.rejectTurns(new Error('claude_session_closed'))
  }

  private async *promptStream(): AsyncGenerator<SDKUserMessage> {
    while (!this.closed) {
      const message =
        this.prompts.shift() ??
        (await new Promise<SDKUserMessage | null>((resolve) => this.promptWaiters.push(resolve)))
      if (message) {
        yield message
      }
    }
  }

  private enqueuePrompt(message: SDKUserMessage): void {
    const waiter = this.promptWaiters.shift()
    if (waiter) {
      waiter(message)
    } else {
      this.prompts.push(message)
    }
  }

  private rejectTurns(error: unknown): void {
    const failure = error instanceof Error ? error : new Error(String(error))
    for (const turn of this.turns.splice(0)) {
      turn.reject(failure)
    }
  }

  private async publishTranscriptPath(sessionId: string): Promise<void> {
    const path = await resolveSessionFilePath('claude', sessionId).catch(() => null)
    if (path && this.sessionId === sessionId) {
      this.options.sink.setTranscriptPath(path)
    }
  }

  private publishCurrentTranscriptPath(): Promise<void> {
    return this.sessionId ? this.publishTranscriptPath(this.sessionId) : Promise.resolve()
  }
}
