import type { Readable, Writable } from 'node:stream'
import type { z } from 'zod'
import { MAX_TIMER_DELAY_MS } from '../../shared/timer-delay'
import {
  AcpAgentError,
  AcpAuthRequiredError,
  AcpInvalidResponseError,
  AcpRpcError
} from './acp-errors'
import { AcpJsonRpcPeer, type AcpPeerOptions, type AcpRequestContext } from './acp-json-rpc-peer'
import {
  answerAcpPermission,
  readAcpPermissionRequest,
  type AcpPermissionHandler
} from './acp-permission-requests'
import { readAcpSessionEvent, type AcpSessionEvent } from './acp-session-events'
import {
  cancelAcpPromptForStop,
  requestAcpSteerCancel,
  type AcpCancelChannel,
  type ActivePrompt
} from './acp-prompt-cancel'
import {
  setupAcpSession,
  type AcpSessionStarted,
  type AcpSessionStartOptions
} from './acp-session-setup'
export type { AcpSessionStarted, AcpSessionStartOptions } from './acp-session-setup'
export type { AcpSessionEvent } from './acp-session-events'
import {
  ACP_PROTOCOL_VERSION,
  InitializeResponseSchema,
  AuthenticateResponseSchema,
  PromptResponseSchema,
  SetSessionModeResponseSchema,
  SetSessionModelResponseSchema,
  SetSessionConfigOptionResponseSchema,
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
} from './generated/acp-protocol.generated'

type Meta = PromptRequest['_meta']
const withMeta = (meta: Meta): { _meta?: Meta } => (meta ? { _meta: meta } : {})

export type AcpSessionRuntimeOptions = {
  clientInfo?: InitializeRequest['clientInfo']
  peer?: AcpPeerOptions
  cancelTimeoutMs?: number
  onPermission?: AcpPermissionHandler
  /** Agent requests other than permissions. The handler owns its request: once `context.signal`
   *  aborts, send the agent's own cancelled reply, finish an answer already in progress, or throw
   *  (-32800). The runtime never answers for it; a request left unanswered ends at `close()`. */
  onRequest?: (method: string, params: unknown, context: AcpRequestContext) => unknown
  /** Agent notifications other than `session/update` (protocol extensions), delivered
   *  synchronously in arrival order with the `subscribe` events. */
  onExtensionNotification?: (method: string, params: unknown) => void
  onDiagnostic?: (message: string) => void
  onClose?: (error: Error) => void
}

export class AcpSessionRuntime {
  private readonly peer: AcpJsonRpcPeer
  private readonly listeners = new Set<(event: AcpSessionEvent) => void>()
  private initialized?: Promise<InitializeResponse>
  private starting?: Promise<AcpSessionStarted>
  private started?: AcpSessionStarted
  private activePrompt?: ActivePrompt
  private reportedUpdateAnomaly = false

  constructor(
    input: Readable,
    output: Writable,
    private readonly options: AcpSessionRuntimeOptions = {}
  ) {
    const timeout = options.cancelTimeoutMs
    if (timeout !== undefined && (!Number.isSafeInteger(timeout) || timeout <= 0)) {
      throw new Error('ACP timeouts must be positive finite timer durations')
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

  async prompt(prompt: PromptRequest['prompt'], meta?: Meta): Promise<PromptResponse> {
    if (this.activePrompt) {
      throw new Error('ACP prompt already in progress')
    }
    const params: PromptRequest = { sessionId: this.sessionId(), prompt, ...withMeta(meta) }
    const active: ActivePrompt = {
      cancelling: false,
      response: this.call('session/prompt', params, PromptResponseSchema)
    }
    this.activePrompt = active
    active.response = active.response.finally(() => {
      if (this.activePrompt === active) {
        this.activePrompt = undefined
      }
    })
    return active.response
  }

  /** A Stop's cancel (`cancelAcpPromptForStop`): bounded, and past the bound it closes. A prompt
   *  that settles in time leaves the agent running; the Stop's owner ends its process. */
  cancel(options: { meta?: CancelNotification['_meta'] } = {}): Promise<void> {
    const channel = this.cancelChannel(options.meta)
    return channel
      ? cancelAcpPromptForStop(this.activePrompt, channel)
      : Promise.reject(new Error('ACP session has not started'))
  }

  /** A steer's cancel (`requestAcpSteerCancel`): never bounded and never closes. */
  requestSteerCancel(options: { meta?: CancelNotification['_meta'] } = {}): Promise<void> {
    const channel = this.cancelChannel(options.meta)
    return channel ? requestAcpSteerCancel(this.activePrompt, channel) : Promise.resolve()
  }

  async setMode(modeId: string, meta?: Meta): Promise<SetSessionModeResponse> {
    const params: SetSessionModeRequest = { sessionId: this.sessionId(), modeId, ...withMeta(meta) }
    return this.call('session/set_mode', params, SetSessionModeResponseSchema)
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
    const request =
      typeof value === 'boolean'
        ? ({
            configId,
            value,
            sessionId,
            type: 'boolean',
            ...withMeta(meta)
          } satisfies SetSessionConfigOptionRequest)
        : ({
            configId,
            value,
            sessionId,
            ...withMeta(meta)
          } satisfies SetSessionConfigOptionRequest)
    return this.call('session/set_config_option', request, SetSessionConfigOptionResponseSchema)
  }

  // The process owner must call close on child exit, even if descendants keep stdio open.
  close(error?: Error): void {
    this.peer.close(error)
    this.listeners.clear()
  }

  private cancelChannel(meta: CancelNotification['_meta']): AcpCancelChannel | null {
    if (!this.started) {
      return null
    }
    const params: CancelNotification = { sessionId: this.started.sessionId, ...withMeta(meta) }
    return {
      send: () => this.peer.notify('session/cancel', params),
      cancelIncomingRequests: () => this.peer.cancelIncomingRequests(),
      close: (error) => this.peer.close(error),
      closed: () => this.peer.closed,
      timeoutMs: Math.min(this.options.cancelTimeoutMs ?? 10_000, MAX_TIMER_DELAY_MS)
    }
  }

  private sessionId(): string {
    if (!this.started) {
      throw new Error('ACP session has not started')
    }
    return this.started.sessionId
  }

  private async call<T>(method: string, params: unknown, schema: z.ZodType<T>): Promise<T> {
    const result = await this.peer.request(method, params, { timeoutMs: null }).catch((error) => {
      if (error instanceof AcpAgentError && error.code === -32000) {
        throw new AcpAuthRequiredError(error.message, error.data)
      }
      throw error
    })
    const parsed = schema.safeParse(result)
    if (!parsed.success) {
      throw new AcpInvalidResponseError(
        `Invalid ACP response: ${method}`,
        result,
        parsed.error.issues
      )
    }
    return parsed.data
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
    // Whether a turn the agent began itself may ask is the caller's call; the runtime cannot see it.
    if (this.activePrompt?.cancelling || request.sessionId !== this.started?.sessionId) {
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
