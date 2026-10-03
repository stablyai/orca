import type { Readable, Writable } from 'node:stream'
import type { z } from 'zod'
import { AcpRequestTimeoutError, AcpRpcError } from './acp-errors'
import { AcpJsonRpcPeer, type AcpPeerOptions, type AcpRequestContext } from './acp-json-rpc-peer'
import { AcpPermissionRequests, type AcpPermissionHandler } from './acp-permission-requests'
import {
  setupAcpSession,
  type AcpSessionStarted,
  type AcpSessionStartOptions
} from './acp-session-setup'
export type { AcpSessionStarted, AcpSessionStartOptions } from './acp-session-setup'
import { ACP_PROTOCOL_VERSION } from './generated/license.gen'
import {
  InitializeResponseSchema,
  AuthenticateResponseSchema,
  PromptResponseSchema,
  RequestPermissionRequestSchema,
  SessionNotificationSchema,
  SetSessionModeResponseSchema,
  SetSessionModelResponseSchema,
  SetSessionConfigOptionResponseSchema,
  type InitializeRequest,
  type InitializeResponse,
  type AuthenticateResponse,
  type PromptRequest,
  type PromptResponse,
  type SessionNotification,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SetSessionModeResponse,
  type SetSessionModelResponse
} from './generated/protocol.gen'

export type AcpSessionRuntimeOptions = {
  clientInfo?: InitializeRequest['clientInfo']
  peer?: AcpPeerOptions
  promptTimeoutMs?: number
  cancelTimeoutMs?: number
  onPermission?: AcpPermissionHandler
  onRequest?: (method: string, params: unknown, context: AcpRequestContext) => unknown
  onDiagnostic?: (message: string) => void
  onClose?: (error: Error) => void
}
type ActivePrompt = {
  response: Promise<PromptResponse>
  cancelling: boolean
  cancelPromise?: Promise<void>
}

export class AcpSessionRuntime {
  private readonly peer: AcpJsonRpcPeer
  private readonly permissions = new AcpPermissionRequests()
  private readonly listeners = new Set<(event: SessionNotification) => void>()
  private initialized?: Promise<InitializeResponse>
  private starting?: Promise<AcpSessionStarted>
  private started?: AcpSessionStarted
  private activePrompt?: ActivePrompt

  constructor(
    input: Readable,
    output: Writable,
    private readonly options: AcpSessionRuntimeOptions = {}
  ) {
    for (const timeout of [options.promptTimeoutMs, options.cancelTimeoutMs]) {
      if (
        timeout !== undefined &&
        (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 2_147_483_647)
      ) {
        throw new Error('ACP timeouts must be positive finite timer durations')
      }
    }
    this.peer = new AcpJsonRpcPeer(
      input,
      output,
      {
        onRequest: (method, params, context) => this.handleRequest(method, params, context),
        onNotification: (method, params) => this.handleNotification(method, params),
        onDiagnostic: options.onDiagnostic,
        onClose: options.onClose
      },
      options.peer
    )
  }

  subscribe(listener: (event: SessionNotification) => void): () => void {
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
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
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

  start(options: AcpSessionStartOptions): Promise<AcpSessionStarted> {
    if (this.started) {
      return Promise.resolve(this.started)
    }
    this.starting ??= this.initialize()
      .then((initialized) =>
        setupAcpSession(initialized, options, (method, params, schema) =>
          this.call(method, params, schema)
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

  prompt(prompt: PromptRequest['prompt']): Promise<PromptResponse> {
    if (this.activePrompt) {
      return Promise.reject(new Error('ACP prompt already in progress'))
    }
    const sessionId = this.sessionId()
    const active: ActivePrompt = {
      cancelling: false,
      response: this.call('session/prompt', { sessionId, prompt }, PromptResponseSchema, {
        timeoutMs: this.options.promptTimeoutMs ?? 30 * 60_000
      })
    }
    this.activePrompt = active
    active.response = active.response.finally(() => {
      this.permissions.cancel(sessionId)
      if (this.activePrompt === active) {
        this.activePrompt = undefined
      }
    })
    return active.response
  }

  cancel(): Promise<void> {
    const sessionId = this.sessionId()
    const active = this.activePrompt
    if (!active) {
      return Promise.resolve()
    }
    active.cancelling = true
    this.permissions.cancel(sessionId)
    active.cancelPromise ??= this.cancelActive(sessionId, active)
    return active.cancelPromise
  }

  private async cancelActive(sessionId: string, active: ActivePrompt): Promise<void> {
    const timeoutMs = this.options.cancelTimeoutMs ?? 10_000
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        this.peer.notify('session/cancel', { sessionId }).then(() => active.response),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            const error = new AcpRequestTimeoutError('session/cancel')
            this.peer.close(error)
            reject(error)
          }, timeoutMs)
        })
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  setMode(modeId: string): Promise<SetSessionModeResponse> {
    return this.call(
      'session/set_mode',
      { sessionId: this.sessionId(), modeId },
      SetSessionModeResponseSchema
    )
  }
  setModel(modelId: string): Promise<SetSessionModelResponse> {
    return this.call(
      'session/set_model',
      { sessionId: this.sessionId(), modelId },
      SetSessionModelResponseSchema
    )
  }
  setConfigOption(
    configId: SetSessionConfigOptionRequest['configId'],
    value: SetSessionConfigOptionRequest['value']
  ): Promise<SetSessionConfigOptionResponse> {
    const sessionId = this.sessionId()
    const request =
      typeof value === 'boolean'
        ? ({ configId, value, sessionId, type: 'boolean' } satisfies SetSessionConfigOptionRequest)
        : ({ configId, value, sessionId } satisfies SetSessionConfigOptionRequest)
    return this.call('session/set_config_option', request, SetSessionConfigOptionResponseSchema)
  }

  close(error?: Error): void {
    this.peer.close(error)
    this.listeners.clear()
  }

  private sessionId(): string {
    if (!this.started) {
      throw new Error('ACP session has not started')
    }
    return this.started.sessionId
  }

  private async call<T>(
    method: string,
    params: unknown,
    schema: z.ZodType<T>,
    options?: { timeoutMs?: number }
  ): Promise<T> {
    const result = await this.peer.request(method, params, options).catch((error) => {
      // A timed-out mutation may still be executing; this runtime cannot safely reuse the session.
      if (error instanceof AcpRequestTimeoutError) {
        this.peer.close(error)
      }
      throw error
    })
    const parsed = schema.safeParse(result)
    if (!parsed.success) {
      throw new AcpRpcError(-32603, `Invalid ACP response: ${method}`)
    }
    return parsed.data
  }

  private handleRequest(method: string, params: unknown, context: AcpRequestContext): unknown {
    if (method !== 'session/request_permission') {
      return this.options.onRequest?.(method, params, context)
    }
    const parsed = RequestPermissionRequestSchema.safeParse(params)
    if (!parsed.success) {
      throw new AcpRpcError(-32602, 'Invalid ACP permission request')
    }
    if (
      !this.activePrompt ||
      this.activePrompt.cancelling ||
      parsed.data.sessionId !== this.started?.sessionId
    ) {
      return { outcome: { outcome: 'cancelled' } }
    }
    return this.permissions.handle(parsed.data, context, this.options.onPermission)
  }

  private handleNotification(method: string, params: unknown): void {
    if (method !== 'session/update') {
      return
    }
    const parsed = SessionNotificationSchema.safeParse(params)
    if (!parsed.success) {
      this.options.onDiagnostic?.('Ignored invalid ACP session update')
      return
    }
    for (const listener of this.listeners) {
      try {
        listener(parsed.data)
      } catch (error) {
        this.options.onDiagnostic?.(`ACP event listener failed: ${String(error)}`)
      }
    }
  }
}
