import type { AcpSessionRuntimeOptions } from './acp-session-runtime-options'
import type { Readable, Writable } from 'node:stream'
import { z } from 'zod'
import { AcpRpcError } from '../transport/acp-errors'
import { AcpPromptRequest } from './acp-prompt-request'
import { callAcpSession } from './acp-session-call'
import { AcpJsonRpcPeer, type AcpRequestContext } from '../transport/acp-json-rpc-peer'
import { answerAcpPermission, readAcpPermissionRequest } from './acp-permission-requests'
import { readAcpSessionEvent, type AcpSessionEvent } from './acp-session-events'
import {
  setupAcpSession,
  type AcpSessionStarted,
  type AcpSessionStartOptions
} from './acp-session-setup'

import {
  ACP_PROTOCOL_VERSION,
  InitializeResponseSchema,
  AuthenticateResponseSchema,
  PromptResponseSchema,
  SetSessionModeResponseSchema,
  SetSessionModelResponseSchema,
  SetSessionConfigOptionResponseSchema,
  SessionIdSchema,
  type InitializeRequest,
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
} from '../generated/acp-protocol.generated'

const ForkSessionResponseSchema = z.looseObject({ sessionId: SessionIdSchema })

type Meta = PromptRequest['_meta']
const withMeta = (meta: Meta): { _meta?: Meta } => (meta ? { _meta: meta } : {})

/** Stream-level protocol seam; production agents use createAcpAgentConnection. */
export class AcpSessionRuntime {
  private readonly peer: AcpJsonRpcPeer
  private readonly listeners = new Set<(event: AcpSessionEvent) => void>()
  private initialized?: Promise<InitializeResponse>
  private starting?: Promise<AcpSessionStarted>
  private started?: AcpSessionStarted
  private readonly prompts: AcpPromptRequest
  private reportedUpdateAnomaly = false

  constructor(
    input: Readable,
    output: Writable,
    private readonly options: AcpSessionRuntimeOptions = {}
  ) {
    this.prompts = new AcpPromptRequest(options.retryBusyPrompts === true)
    this.peer = new AcpJsonRpcPeer(
      input,
      output,
      {
        onRequest: (method, params, context) => this.handleRequest(method, params, context),
        onNotification: (method, params) => this.handleNotification(method, params),
        onDiagnostic: options.onDiagnostic,
        onClose: (error) => {
          this.prompts.close(error)
          options.onClose?.(error)
        },
        ...(options.onOutputEnd ? { onOutputEnd: options.onOutputEnd } : {}),
        onOtherLine: options.onOtherLine
      },
      options.peer
    )
  }

  get closed(): boolean {
    return this.peer.closed
  }

  subscribe(listener: (event: AcpSessionEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  initialize(): Promise<InitializeResponse> {
    this.initialized ??= this.call(
      'initialize',
      {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
          ...this.options.clientCapabilities
        },
        ...(this.options.clientInfo === undefined ? {} : { clientInfo: this.options.clientInfo })
      } satisfies InitializeRequest,
      InitializeResponseSchema
    )
      .then((response) => {
        if (response.protocolVersion !== ACP_PROTOCOL_VERSION) {
          const error = new AcpRpcError(
            -32602,
            `Unsupported ACP protocol version: ${response.protocolVersion}`
          )
          this.peer.close(error)
          throw error
        }
        return response
      })
      .catch((error) => {
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
  async requestSessionFreeExtension(
    method: string,
    params: unknown,
    timeoutMs: number | null = null
  ): Promise<unknown> {
    if (!method.includes('/') || method.startsWith('session/')) {
      throw new Error(`Not an ACP extension method: ${method}`)
    }
    await this.initialize()
    return this.peer.request(method, params, { timeoutMs })
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
          (method, params, schema, accepted) => this.call(method, params, schema, accepted),
          (started) => {
            received?.(started)
            this.started = started
          }
        )
      )
      .catch((error) => {
        this.starting = undefined
        throw error
      })
    return this.starting
  }

  async prompt(prompt: PromptRequest['prompt'], meta?: Meta): Promise<PromptResponse> {
    const params: PromptRequest = { sessionId: this.sessionId(), prompt, ...withMeta(meta) }
    return this.prompts.run(() => this.call('session/prompt', params, PromptResponseSchema))
  }

  /** Stop and steering share this notification; the adapter owns their completion policy. */
  cancel(options: { meta?: CancelNotification['_meta'] } = {}): Promise<void> {
    if (!this.started) {
      return Promise.reject(new Error('ACP session has not started'))
    }
    this.prompts.cancel()
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
  /** `timeoutMs` drops an unanswered call from the pending set; null waits for the answer. */
  async setModel(
    modelId: string,
    meta?: Meta,
    timeoutMs: number | null = null
  ): Promise<SetSessionModelResponse> {
    const params: SetSessionModelRequest = {
      sessionId: this.sessionId(),
      modelId,
      ...withMeta(meta)
    }
    return this.call(
      'session/set_model',
      params,
      SetSessionModelResponseSchema,
      undefined,
      timeoutMs
    )
  }
  async setConfigOption(
    configId: SetSessionConfigOptionRequest['configId'],
    value: SetSessionConfigOptionRequest['value'],
    meta?: Meta,
    received?: (response: SetSessionConfigOptionResponse) => void,
    timeoutMs: number | null = null
  ): Promise<SetSessionConfigOptionResponse> {
    const params = { configId, sessionId: this.sessionId(), ...withMeta(meta) }
    const request =
      typeof value === 'boolean'
        ? ({ ...params, value, type: 'boolean' } satisfies SetSessionConfigOptionRequest)
        : ({ ...params, value } satisfies SetSessionConfigOptionRequest)
    return this.call(
      'session/set_config_option',
      request,
      SetSessionConfigOptionResponseSchema,
      received,
      timeoutMs
    )
  }

  close(error?: Error): void {
    this.peer.close(error)
    this.listeners.clear()
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

  protected call<T>(
    method: string,
    params: unknown,
    schema: z.ZodType<T>,
    received?: (response: T) => void,
    timeoutMs: number | null = null
  ): Promise<T> {
    return callAcpSession(
      this.peer,
      method,
      params,
      schema,
      this.options.onAuthAnswered,
      received,
      timeoutMs
    )
  }

  private handleRequest(method: string, params: unknown, context: AcpRequestContext): unknown {
    if (method !== 'session/request_permission') {
      if (!this.options.onRequest) {
        throw new AcpRpcError(-32601, `Unknown ACP client method: ${method}`)
      }
      return this.options.onRequest(method, params, context)
    }
    const diagnose = (message: string): void => this.diagnose(message)
    const request = readAcpPermissionRequest(params, diagnose)
    if (!request) {
      throw new AcpRpcError(-32602, 'Invalid ACP permission request')
    }
    // Only the started session asks the caller; the caller decides who can answer.
    if (request.sessionId !== this.started?.sessionId) {
      return { outcome: { outcome: 'cancelled' } }
    }
    return answerAcpPermission(request, context, this.options.onPermission, diagnose)
  }

  private diagnose(message: string): void {
    try {
      this.options.onDiagnostic?.(message)
    } catch {
      /* Diagnostics cannot prevent event delivery. */
    }
  }

  private handleNotification(method: string, params: unknown): void {
    if (method !== 'session/update') {
      try {
        this.options.onExtensionNotification?.(method, params)
      } catch (error) {
        this.diagnose(`ACP extension listener failed: ${String(error)}`)
      }
      return
    }
    const event = readAcpSessionEvent(params)
    if (!event) {
      this.diagnose('Ignored invalid ACP session update envelope')
      return
    }
    if (event.kind === 'unrecognized' && !this.reportedUpdateAnomaly) {
      this.reportedUpdateAnomaly = true
      this.diagnose('Forwarded unrecognized ACP session update')
    }
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (error) {
        this.diagnose(`ACP event listener failed: ${String(error)}`)
      }
    }
  }
}
