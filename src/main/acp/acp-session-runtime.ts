import type { AcpSessionRuntimeOptions } from './acp-session-runtime-options'
export type { AcpSessionRuntimeOptions } from './acp-session-runtime-options'
import type { Readable, Writable } from 'node:stream'
import { z } from 'zod'
import { callAcpSession, type AcpSessionResponse } from './acp-response-settlement'
import { AcpJsonRpcPeer, type AcpRequestContext } from './acp-json-rpc-peer'
import { handleAcpClientRequest } from './acp-permission-requests'
import { AcpSessionEvents, type AcpSessionEvent } from './acp-session-events'
import { setupAcpSession, initializeAcpSession, acpSessionConfigRequest } from './acp-session-setup'
import type { AcpSessionStarted, AcpSessionStartOptions } from './acp-session-setup'
export type { AcpSessionStarted, AcpSessionStartOptions } from './acp-session-setup'
export type { AcpSessionEvent } from './acp-session-events'
import {
  AuthenticateResponseSchema,
  PromptResponseSchema,
  SetSessionModeResponseSchema,
  SetSessionModelResponseSchema,
  SetSessionConfigOptionResponseSchema,
  SessionIdSchema,
  type InitializeResponse,
  type AuthenticateResponse,
  type CancelNotification,
  type PromptRequest,
  type PromptResponse,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
  type SetSessionModelRequest,
  type SetSessionModelResponse
} from './generated/acp-protocol.generated'

const ForkSessionResponseSchema = z.looseObject({ sessionId: SessionIdSchema })

type Meta = PromptRequest['_meta']
const withMeta = (meta: Meta): { _meta?: Meta } => (meta ? { _meta: meta } : {})

/** Stream-level protocol seam; production agents use createAcpAgentConnection. */
export class AcpSessionRuntime {
  private readonly peer: AcpJsonRpcPeer
  private readonly events: AcpSessionEvents
  private initialized?: Promise<InitializeResponse>
  private starting?: Promise<AcpSessionStarted>
  private started?: AcpSessionStarted
  private activePrompt?: object
  private promptNormalization?: { original: Error; finish: (error: Error) => void }

  constructor(
    input: Readable,
    output: Writable,
    private readonly options: AcpSessionRuntimeOptions = {}
  ) {
    this.events = new AcpSessionEvents(options, (message) => this.diagnose(message))
    this.peer = new AcpJsonRpcPeer(
      input,
      output,
      {
        onRequest: (method, params, context) => this.handleRequest(method, params, context),
        onNotification: (method, params) => this.handleNotification(method, params),
        onDiagnostic: options.onDiagnostic,
        onClose: options.onClose,
        onOtherLine: options.onOtherLine
      },
      options.peer
    )
  }

  get closed(): boolean {
    return this.peer.closed
  }

  subscribe(listener: (event: AcpSessionEvent) => void): () => void {
    return this.events.subscribe(listener)
  }

  initialize(): Promise<InitializeResponse> {
    this.initialized ??= initializeAcpSession(
      this.peer,
      this.options.clientInfo,
      this.options.onAuthAnswered
    ).catch((error) => {
      this.initialized = undefined
      throw error
    })
    return this.initialized
  }

  async authenticate(methodId: string): Promise<AuthenticateResponse> {
    await this.initialize()
    return this.call('authenticate', { methodId }, AuthenticateResponseSchema)
  }

  /** Reject core session methods for session-free discovery. */
  async requestSessionFreeExtension(method: string, params: unknown): Promise<unknown> {
    if (!method.includes('/') || method.startsWith('session/')) {
      throw new Error(`Not an ACP extension method: ${method}`)
    }
    await this.initialize()
    return this.peer.request(method, params, { timeoutMs: null })
  }

  /** Fork without starting a session here; requires advertised fork support. */
  async forkSession(sessionId: string, cwd: string): Promise<string> {
    const params = { sessionId, cwd, mcpServers: [] }
    return (await this.call('session/fork', params, ForkSessionResponseSchema)).sessionId
  }

  /** Requires advertised session deletion support. */
  deleteSession = (sessionId: string) => this.call('session/delete', { sessionId }, z.unknown())

  start(
    options: AcpSessionStartOptions,
    received?: (started: AcpSessionStarted) => void
  ): Promise<AcpSessionStarted> {
    if (this.started) {
      return Promise.resolve(this.started)
    }
    this.starting ??= this.initialize()
      .then((initialized) =>
        setupAcpSession(
          initialized,
          options,
          (method, params, schema, settle) => this.call(method, params, schema, settle),
          (started) => {
            this.started = started
            received?.(started)
          }
        )
      )
      .then((started) => {
        this.started = started
        return started
      })
      .catch((error) => {
        this.starting = undefined
        throw error
      })
    return this.starting
  }

  prompt(
    prompt: PromptRequest['prompt'],
    meta?: Meta,
    received?: (response: AcpSessionResponse<PromptResponse>) => void
  ): Promise<PromptResponse> {
    const identity = {}
    const startedAt = Date.now()
    let delivered = false
    let rawSettled = false
    const result = Promise.withResolvers<PromptResponse>()
    const deliver = (response: AcpSessionResponse<PromptResponse>): void => {
      if (delivered) {
        return
      }
      delivered = true
      if (this.activePrompt === identity) {
        this.activePrompt = undefined
      }
      try {
        received?.(response)
        if ('error' in response) {
          result.reject(response.error)
        } else {
          result.resolve(response.value)
        }
      } catch (error) {
        result.reject(error)
      }
    }
    const fail = (cause: unknown): void => {
      if (delivered) {
        return
      }
      const error = cause instanceof Error ? cause : new Error(String(cause))
      const hook = this.options.normalizePromptError
      if (!hook || this.closed || !this.started || this.activePrompt !== identity) {
        deliver({ error })
        return
      }
      const slot = {
        original: error,
        finish: (finalError: Error): void => {
          if (this.promptNormalization !== slot) {
            return
          }
          this.promptNormalization = undefined
          deliver({ error: finalError })
        }
      }
      this.promptNormalization = slot
      try {
        const normalized = hook(error, {
          sessionId: this.started.sessionId,
          startedAt,
          closed: () => this.closed
        })
        if (normalized instanceof Promise) {
          void normalized.then(slot.finish, () => slot.finish(error))
        } else {
          slot.finish(normalized)
        }
      } catch {
        slot.finish(error)
      }
    }
    try {
      if (this.activePrompt) {
        throw new Error('ACP prompt already in progress')
      }
      const params: PromptRequest = { sessionId: this.sessionId(), prompt, ...withMeta(meta) }
      this.activePrompt = identity
      void this.call('session/prompt', params, PromptResponseSchema, (response) => {
        rawSettled = true
        if ('error' in response) {
          fail(response.error)
        } else {
          deliver(response)
        }
      }).catch((error: unknown) => {
        if (!rawSettled) {
          fail(error)
        }
      })
    } catch (error) {
      fail(error)
    }
    return result.promise
  }

  /** Stop and steering share this notification; the adapter owns their completion policy. */
  cancel(options: { meta?: CancelNotification['_meta'] } = {}): Promise<void> {
    if (!this.started) {
      return Promise.reject(new Error('ACP session has not started'))
    }
    const params: CancelNotification = {
      sessionId: this.started.sessionId,
      ...withMeta(options.meta)
    }
    return this.peer.notify('session/cancel', params)
  }

  async setMode(modeId: string, meta?: Meta): Promise<SetSessionModeResponse> {
    const params: SetSessionModeRequest = { sessionId: this.sessionId(), modeId, ...withMeta(meta) }
    return this.call('session/set_mode', params, SetSessionModeResponseSchema)
  }

  requestExtension(method: string, params: unknown, timeoutMs = 30_000): Promise<unknown> {
    this.sessionId()
    if (!method.startsWith('_')) {
      throw new Error('ACP extension methods require an underscore')
    }
    return this.peer.request(method, params, { timeoutMs })
  }
  async setModel(modelId: string, meta?: Meta): Promise<SetSessionModelResponse> {
    const params: SetSessionModelRequest = {
      sessionId: this.sessionId(),
      modelId,
      ...withMeta(meta)
    }
    return this.call('session/set_model', params, SetSessionModelResponseSchema)
  }
  async setConfigOption(
    configId: SetSessionConfigOptionRequest['configId'],
    value: SetSessionConfigOptionRequest['value'],
    meta?: Meta
  ): Promise<SetSessionConfigOptionResponse> {
    const sessionId = this.sessionId()
    const request = acpSessionConfigRequest(sessionId, configId, value, meta)
    return this.call('session/set_config_option', request, SetSessionConfigOptionResponseSchema)
  }

  close(error?: Error): void {
    this.peer.close(error)
    const pending = this.promptNormalization
    pending?.finish(pending.original)
    this.events.clear()
  }

  protected get inputEnding(): boolean {
    return this.peer.inputEnding
  }

  protected finishInput(): Promise<void> {
    return this.peer.finishInput()
  }

  protected drainNotifications(error?: Error): void {
    this.peer.drainNotifications(error)
  }

  private sessionId(): string {
    if (!this.started) {
      throw new Error('ACP session has not started')
    }
    return this.started.sessionId
  }

  private call<T>(
    method: string,
    params: unknown,
    schema: z.ZodType<T>,
    received?: (response: AcpSessionResponse<T>) => void
  ): Promise<T> {
    return callAcpSession(this.peer, method, params, schema, this.options.onAuthAnswered, received)
  }

  private handleRequest(method: string, params: unknown, context: AcpRequestContext): unknown {
    return handleAcpClientRequest(
      method,
      params,
      context,
      this.options,
      () => this.started?.sessionId,
      (message) => this.diagnose(message)
    )
  }

  private diagnose(message: string): void {
    try {
      this.options.onDiagnostic?.(message)
    } catch {
      /* Diagnostics cannot prevent event delivery. */
    }
  }

  private handleNotification(method: string, params: unknown): void {
    this.events.handle(method, params)
  }
}
