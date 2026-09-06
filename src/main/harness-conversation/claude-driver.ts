import { query, type CanUseTool, type Query } from '@anthropic-ai/claude-agent-sdk'
import { spawnProcess } from '../../shared/child-process/run-process'
import type { HarnessConversationDriver } from './driver'
import {
  claudeTextMessage,
  emitClaudeAssistant,
  emitClaudeBufferedCommentary,
  emitClaudeFinal,
  emitClaudeStreamDelta,
  emitClaudeToolResults
} from './claude-message'
import { harnessProcessInvocation } from './harness-process-invocation'
import type { SessionOptionValue } from '../../shared/native-chat-session-options'
import type { StructuredProviderConfiguration } from '../../shared/structured-agent-provider'
import { claudeConversationConfiguration } from './claude-configuration'
import { ClaudeInteractionController } from './claude-interaction-controller'
import { resolveSessionFilePath } from '../native-chat/session-file-resolver'
import { ClaudeConversationActivity } from './claude-activity'
import { readClaudeTranscriptMetadata } from './claude-transcript-metadata'
import { claudeUserMessage } from './claude-user-message'
import { ClaudeSteerController, type ClaudeTurn } from './claude-steer-controller'
import { ClaudePromptQueue } from './claude-prompt-queue'
import type { ClaudeDriverOptions } from './claude-driver-options'

export class ClaudeConversationDriver implements HarnessConversationDriver {
  private readonly current: Query
  private sessionId: string | null
  private readonly prompts = new ClaudePromptQueue()
  private readonly turns: ClaudeTurn[] = []
  private readonly steers = new ClaudeSteerController(this.turns)
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
      prompt: this.prompts.stream(),
      options: {
        abortController,
        cwd: this.options.cwd,
        env: this.options.env,
        includePartialMessages: true,
        extraArgs: { 'replay-user-messages': null },
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
          const child = spawnProcess({
            program: invocation.command,
            args: invocation.args,
            cwd,
            env,
            signal,
            stdio: ['pipe', 'pipe', 'pipe']
          })
          if (child.pid !== undefined) {
            this.options.sink.setProcessId?.(child.pid)
          }
          child.stderr?.on('data', () => undefined)
          return child
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

  ready = (): Promise<void> => this.readyPromise

  async send(
    text: string,
    imagePaths?: readonly string[],
    submission?: Parameters<HarnessConversationDriver['send']>[2]
  ): Promise<void> {
    await this.readyPromise
    if (this.closed) {
      throw new Error('claude_session_closed')
    }
    const message = claudeUserMessage(text, imagePaths, submission?.clientMessageId)
    const completion = new Promise<void>((resolve, reject) => this.turns.push({ resolve, reject }))
    this.prompts.enqueue(message)
    submission?.accepted()
    return completion
  }

  async steer(
    text: string,
    imagePaths: readonly string[] | undefined,
    clientMessageId: string,
    accept: Parameters<NonNullable<HarnessConversationDriver['steer']>>[3]
  ): Promise<void> {
    await this.readyPromise
    const originalTurn = this.turns[0]
    if (this.closed || !originalTurn) {
      throw new Error('conversation_not_working')
    }
    const message = {
      ...claudeUserMessage(text, imagePaths, clientMessageId),
      priority: 'next' as const
    }
    const accepted = this.steers.waitForReplay(message.uuid!, originalTurn, accept)
    this.prompts.enqueue(message)
    return accepted
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
    let lastAssistantId: string | null = null
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
            streamingId = `claude:${message.uuid}`
            streamedText.clear()
          } else if (event.type === 'content_block_delta') {
            emitClaudeStreamDelta(this.options.sink, event, message.uuid, streamingId, streamedText)
          }
        } else if (message.type === 'assistant' && message.parent_tool_use_id === null) {
          lastAssistantId = emitClaudeAssistant(
            this.options.sink,
            message,
            streamingId,
            streamedText
          )
          streamingId = null
        } else if (message.type === 'user' && message.parent_tool_use_id === null) {
          if (
            message.uuid &&
            'isReplay' in message &&
            message.isReplay === true &&
            (await this.steers.observeReplay(message.uuid))
          ) {
            continue
          }
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
          void (this.sessionId && this.publishTranscriptPath(this.sessionId))
          emitClaudeBufferedCommentary(this.options.sink, streamedText)
          const failure =
            'result' in message && typeof message.result === 'string'
              ? message.result
              : message.subtype
          this.turns.shift()?.reject(new Error(failure))
          streamedText.clear()
          streamingId = null
          lastAssistantId = null
        } else if (message.type === 'result') {
          void (this.sessionId && this.publishTranscriptPath(this.sessionId))
          emitClaudeFinal(
            this.options.sink,
            lastAssistantId ?? streamingId ?? `claude:${message.uuid}`,
            'result' in message ? message.result : ''
          )
          this.turns.shift()?.resolve()
          streamedText.clear()
          streamingId = null
          lastAssistantId = null
        }
      }
    } catch (error) {
      emitClaudeBufferedCommentary(this.options.sink, streamedText)
      this.rejectTurns(error)
      this.steers.rejectAll()
    } finally {
      this.rejectTurns(new Error('claude_session_closed'))
      this.options.sink.end?.(this.closed ? 'requested-close' : 'provider stream ended')
      this.steers.rejectAll()
    }
  }

  async interrupt(): Promise<void> {
    try {
      await this.current.interrupt()
    } finally {
      this.interactions.cancel()
      this.steers.rejectAll()
    }
  }

  answerPermission = (requestId: string, optionId: string): void =>
    this.interactions.answerPermission(requestId, optionId)

  answerInput = (requestId: string, answers: Record<string, string[]>): void =>
    this.interactions.answerInput(requestId, answers)

  async close(): Promise<void> {
    this.closed = true
    this.prompts.close()
    this.current.close()
    this.interactions.cancel()
    this.rejectTurns(new Error('claude_session_closed'))
    this.steers.rejectAll()
  }

  private rejectTurns(error: unknown): void {
    const failure = error instanceof Error ? error : new Error(String(error))
    this.turns.splice(0).forEach((turn) => turn.reject(failure))
  }

  private async publishTranscriptPath(sessionId: string): Promise<void> {
    const path = await resolveSessionFilePath(this.options.agent, sessionId).catch(() => null)
    if (path && this.sessionId === sessionId) {
      const metadata = await readClaudeTranscriptMetadata(path).catch(() => null)
      if (metadata && this.sessionId === sessionId) {
        this.activity.setTranscriptMetadata(metadata)
      }
      this.options.sink.setTranscriptPath(path)
    }
  }
}
