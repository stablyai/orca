import { randomUUID } from 'node:crypto'
import type { HarnessConversationDriver, HarnessConversationDriverSink } from './driver'
import type { SessionOptionValue } from '../../shared/native-chat-session-options'
import { OmpRpcConnection, OmpRpcError, type OmpRpcFrame } from './omp-rpc-connection'
import {
  ompConfiguration,
  ompContext,
  ompPrompt,
  ompToolMessage,
  parseOmpCommands,
  parseOmpModels,
  type OmpCommand
} from './omp-rpc-projection'
import { OmpRpcInteractions } from './omp-rpc-interactions'
import { OmpRpcTurnQueue } from './omp-rpc-turn-queue'
import { completeOmpResponse, ompAssistantMessage, type OmpTextStreams } from './omp-rpc-message'

type OmpRpcDriverOptions = {
  cwd: string
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
  sink: HarnessConversationDriverSink
}

export class OmpRpcConversationDriver implements HarnessConversationDriver {
  private readonly connection: OmpRpcConnection
  private readonly initialized: Promise<void>
  private readonly turnQueue = new OmpRpcTurnQueue()
  private readonly interactions: OmpRpcInteractions
  private readonly streams: OmpTextStreams = new Map()
  private responseId: string | null = null
  private commands: OmpCommand[] = []
  private modelChoices: { label: string; value: string }[] = []
  private currentModel = ''
  private currentEffort = 'medium'
  private interrupted = false

  constructor(private readonly options: OmpRpcDriverOptions) {
    this.connection = new OmpRpcConnection(
      options.command,
      options.args,
      options.env,
      options.cwd,
      (frame) => this.frame(frame),
      (error) => this.fail(error)
    )
    options.sink.setProcessId?.(this.connection.pid)
    this.interactions = new OmpRpcInteractions(options.sink, (frame) =>
      this.connection.write(frame)
    )
    this.initialized = this.initialize()
  }

  ready(): Promise<void> {
    return this.initialized
  }

  async send(
    text: string,
    imagePaths?: readonly string[],
    submission?: Parameters<HarnessConversationDriver['send']>[2]
  ): Promise<void> {
    await this.initialized
    this.interrupted = false
    const requestId =
      (submission?.clientMessageId as ReturnType<typeof randomUUID> | undefined) ?? randomUUID()
    const completion = this.turnQueue.push(requestId)
    let response: OmpRpcFrame
    try {
      response = await this.connection.request('prompt', ompPrompt(text, imagePaths), requestId)
    } catch (error) {
      this.turnQueue.complete(requestId)
      if (submission && !(error instanceof OmpRpcError)) {
        throw new Error('conversation_send_uncertain')
      }
      throw error
    }
    submission?.accepted()
    const data = response.data as { agentInvoked?: unknown } | undefined
    if (data?.agentInvoked === false) {
      this.turnQueue.complete(requestId)
    }
    return completion
  }

  async steer(
    text: string,
    imagePaths: readonly string[] | undefined,
    clientMessageId: string,
    accept: Parameters<NonNullable<HarnessConversationDriver['steer']>>[3]
  ): Promise<void> {
    await this.initialized
    const originalTurn = this.turnQueue.turns[0]
    if (!originalTurn) {
      throw new Error('conversation_not_working')
    }
    const next = this.turnQueue.create(clientMessageId)
    this.turnQueue.turns.push(next.turn)
    let providerAccepted = false
    try {
      await this.connection.request(
        'steer',
        ompPrompt(text, imagePaths),
        clientMessageId as ReturnType<typeof randomUUID>
      )
      providerAccepted = true
      if (this.turnQueue.turns.includes(originalTurn)) {
        this.turnQueue.remove(next.turn)
        await accept({ placement: 'current' })
      } else {
        await accept({ placement: 'next', completion: next.completion })
      }
    } catch (error) {
      this.turnQueue.remove(next.turn)
      if (!providerAccepted && error instanceof OmpRpcError) {
        throw new Error('omp_steer_rejected')
      }
      throw new Error('conversation_steer_uncertain')
    }
  }

  async interrupt(): Promise<void> {
    await this.initialized
    this.interrupted = true
    await this.connection.request('abort')
  }

  answerPermission(requestId: string, optionId: string): void {
    this.interactions.answerPermission(requestId, optionId)
  }

  answerInput(requestId: string, answers: Record<string, string[]>): void {
    this.interactions.answerInput(requestId, answers)
  }

  async setOption(optionId: string, value: SessionOptionValue): Promise<void> {
    await this.initialized
    if (typeof value !== 'string') {
      throw new Error('conversation_option_invalid')
    }
    if (optionId === 'model') {
      const slash = value.indexOf('/')
      if (slash < 1) {
        throw new Error('conversation_option_invalid')
      }
      await this.connection.request('set_model', {
        provider: value.slice(0, slash),
        modelId: value.slice(slash + 1)
      })
      this.currentModel = value
    } else if (optionId === 'effort') {
      await this.connection.request('set_thinking_level', { level: value })
      this.currentEffort = value
    } else {
      throw new Error('conversation_option_unknown')
    }
    this.publishConfiguration()
  }

  async compact(): Promise<void> {
    await this.initialized
    await this.connection.request('compact')
  }

  async close(): Promise<void> {
    const error = new Error('omp_rpc_closed')
    this.turnQueue.fail(error)
    await this.connection.close()
  }

  private async initialize(): Promise<void> {
    await this.connection.ready()
    const [stateResponse, commandsResponse, modelsResponse] = await Promise.all([
      this.connection.request('get_state'),
      this.connection.request('get_available_commands'),
      this.connection.request('get_available_models')
    ])
    const state = stateResponse.data as Record<string, unknown> | undefined
    if (typeof state?.sessionId === 'string') {
      this.options.sink.setProviderSessionId(state.sessionId)
    }
    if (typeof state?.sessionFile === 'string') {
      this.options.sink.setTranscriptPath(state.sessionFile)
    }
    const model = state?.model as { provider?: unknown; id?: unknown } | undefined
    if (typeof model?.provider === 'string' && typeof model.id === 'string') {
      this.currentModel = `${model.provider}/${model.id}`
    }
    if (typeof state?.thinkingLevel === 'string') {
      this.currentEffort = state.thinkingLevel
    }
    this.publishContext(state)
    this.commands = parseOmpCommands(commandsResponse.data)
    this.modelChoices = parseOmpModels(modelsResponse.data)
    this.publishConfiguration()
  }

  private frame(frame: OmpRpcFrame): void {
    if (frame.type === 'agent_end') {
      completeOmpResponse(this.options.sink, this.streams, this.responseId)
      void this.refreshContext()
      const turn = this.turnQueue.turns.shift()
      if (this.interrupted) {
        turn?.reject(new Error('turn_interrupted'))
        this.interrupted = false
      } else {
        turn?.resolve()
      }
      return
    }
    if (frame.type === 'message_start') {
      if (ompAssistantMessage(frame.message)) {
        completeOmpResponse(this.options.sink, this.streams, this.responseId)
        this.responseId = `omp:response:${randomUUID()}`
      }
      return
    }
    if (frame.type === 'message_update') {
      const event = frame.assistantMessageEvent as { type?: unknown; delta?: unknown } | undefined
      if (typeof event?.delta === 'string') {
        if (event.type === 'text_delta') {
          this.delta('assistant', event.delta)
        } else if (event.type === 'thinking_delta') {
          this.delta('reasoning', event.delta)
        }
      }
      return
    }
    if (frame.type === 'message_end') {
      const message = ompAssistantMessage(frame.message)
      if (message) {
        completeOmpResponse(this.options.sink, this.streams, this.responseId, message)
        this.responseId = null
      }
      return
    }
    if (frame.type === 'tool_execution_start') {
      this.options.sink.emit({
        type: 'message.completed',
        message: ompToolMessage(frame)
      })
      return
    }
    if (frame.type === 'tool_execution_end') {
      this.options.sink.emit({ type: 'message.completed', message: ompToolMessage(frame) })
      return
    }
    if (frame.type === 'available_commands_update') {
      this.commands = parseOmpCommands({ commands: frame.commands })
      this.publishConfiguration()
      return
    }
    if (frame.type === 'prompt_result' && frame.agentInvoked === false) {
      this.turnQueue.complete(typeof frame.id === 'string' ? frame.id : undefined)
      return
    }
    if (frame.type === 'extension_ui_request') {
      this.interactions.handle(frame)
    }
  }

  private fail(error: Error): void {
    this.turnQueue.fail(error)
    this.options.sink.end?.(error.message)
  }

  private async refreshContext(): Promise<void> {
    const response = await this.connection.request('get_state').catch(() => null)
    this.publishContext(response?.data)
  }

  private publishContext(state: unknown): void {
    const context = ompContext(state, this.currentModel, this.currentEffort)
    if (context) {
      this.options.sink.setContext(context)
    }
  }

  private delta(role: 'assistant' | 'reasoning', text: string): void {
    let stream = this.streams.get(role)
    if (!stream) {
      const responseId = this.responseId ?? `omp:response:${randomUUID()}`
      this.responseId ??= responseId
      stream = { id: `${responseId}:${role}`, text: '' }
      this.streams.set(role, stream)
      this.options.sink.emit({
        type: 'message.started',
        message: {
          id: stream.id,
          role,
          blocks: [{ type: 'text', text: '' }],
          timestamp: Date.now(),
          source: 'stream'
        }
      })
    }
    this.options.sink.emit({
      type: 'message.delta',
      messageId: stream.id,
      blockIndex: 0,
      offset: stream.text.length,
      text
    })
    stream.text += text
  }

  private publishConfiguration(): void {
    this.options.sink.setConfiguration(
      ompConfiguration({
        commands: this.commands,
        modelChoices: this.modelChoices,
        currentModel: this.currentModel,
        currentEffort: this.currentEffort
      })
    )
  }
}
