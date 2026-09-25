import { randomUUID } from 'node:crypto'
import {
  BROWSER_CLIENT_PAGE_RENDERER_REQUEST_CHANNEL,
  BrowserClientPageRendererIdentity,
  BrowserClientPageRendererReply,
  BrowserClientPageRendererRequest,
  type BrowserClientPageRendererIdentity as RendererPageIdentity,
  type BrowserClientPageRendererReply as RendererReply,
  type BrowserClientPageRendererRequest as RendererRequest
} from '../../shared/browser-client-page-renderer-protocol'
import type { BrowserClientPageRenderer } from './browser-client-page-cleanup'
import {
  readCurrentRendererFrame,
  readRendererReplyRequestId,
  rendererReplyMatchesRequest,
  type BrowserClientPageRendererEndpoint,
  type BrowserClientPageRendererFrame,
  type BrowserClientPageRendererReplyEvent
} from './browser-client-page-renderer-reply-admission'

export type {
  BrowserClientPageRendererEndpoint,
  BrowserClientPageRendererReplyEvent
} from './browser-client-page-renderer-reply-admission'

const DEFAULT_MAX_PENDING_REQUESTS = 512
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000

type ReplyListener = (event: BrowserClientPageRendererReplyEvent, reply: unknown) => void

type BrowserClientPageRendererTransport = {
  onReply(listener: ReplyListener): void
  offReply(listener: ReplyListener): void
}

type RendererState = {
  endpoint: BrowserClientPageRendererEndpoint
  frame: BrowserClientPageRendererFrame
  bridge: BrowserClientPageRenderer | null
}

type PendingRequest = {
  state: RendererState
  request: RendererRequest
  signal: AbortSignal | null
  onAbort: (() => void) | null
  timer: ReturnType<typeof setTimeout>
  resolve: (reply: RendererReply) => void
  reject: (error: Error) => void
}

type RendererRequestInput = RendererRequest extends infer Request
  ? Request extends { requestId: string }
    ? Omit<Request, 'requestId'>
    : never
  : never

export class BrowserClientPageRendererBridgeRegistry {
  private readonly maxPending: number
  private readonly timeoutMs: number
  private readonly createRequestId: () => string
  private readonly pending = new Map<string, PendingRequest>()
  private current: RendererState | null = null
  private disposed = false

  constructor(
    private readonly options: {
      transport: BrowserClientPageRendererTransport
      createRequestId?: () => string
      maxPending?: number
      timeoutMs?: number
    }
  ) {
    this.maxPending = options.maxPending ?? DEFAULT_MAX_PENDING_REQUESTS
    this.timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.createRequestId = options.createRequestId ?? randomUUID
    if (
      !Number.isInteger(this.maxPending) ||
      this.maxPending < 1 ||
      !Number.isFinite(this.timeoutMs) ||
      this.timeoutMs <= 0
    ) {
      throw new Error('browser_client_page_renderer_limits_invalid')
    }
    options.transport.onReply(this.onReply)
  }

  attachRenderer(endpoint: BrowserClientPageRendererEndpoint): BrowserClientPageRenderer {
    const frame = this.assertEndpoint(endpoint)
    if (this.disposed) {
      throw new Error('browser_client_page_renderer_registry_disposed')
    }
    const previous = this.current
    if (previous) {
      this.current = null
      this.rejectRendererPending(previous, 'browser_client_page_renderer_replaced')
    }
    const state: RendererState = { endpoint, frame, bridge: null }
    const bridge = Object.freeze({
      rendererWebContentsId: endpoint.id,
      isCurrent: () => this.isCurrent(state),
      mountPage: (page: RendererPageIdentity, signal: AbortSignal) =>
        this.mountPage(state, page, signal),
      rekeyPage: (
        previous: RendererPageIdentity,
        next: RendererPageIdentity,
        signal: AbortSignal
      ) => this.rekeyPage(state, previous, next, signal),
      retirePage: (page: RendererPageIdentity) => this.retirePage(state, page)
    })
    state.bridge = bridge
    this.current = state
    return bridge
  }

  selectRenderer = (): BrowserClientPageRenderer => {
    const state = this.current
    const bridge = state?.bridge
    if (!state || !bridge || !this.isCurrent(state)) {
      throw new Error('browser_client_page_renderer_unavailable')
    }
    return bridge
  }

  retireRenderer(endpoint: BrowserClientPageRendererEndpoint): boolean {
    const state = this.current
    if (!state || state.endpoint !== endpoint) {
      return false
    }
    this.current = null
    this.rejectRendererPending(state, 'browser_client_page_renderer_retired')
    return true
  }

  dispose(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    const state = this.current
    this.current = null
    if (state) {
      this.rejectRendererPending(state, 'browser_client_page_renderer_registry_disposed')
    }
    this.options.transport.offReply(this.onReply)
  }

  private async mountPage(
    state: RendererState,
    candidate: RendererPageIdentity,
    signal: AbortSignal
  ): Promise<{ webContentsId: number }> {
    const page = BrowserClientPageRendererIdentity.parse(candidate)
    const reply = await this.request(state, { type: 'mountPage', page }, signal)
    if (reply.type !== 'mounted') {
      throw new Error(
        reply.type === 'failed' ? reply.errorCode : 'browser_client_page_mount_failed'
      )
    }
    return { webContentsId: reply.webContentsId }
  }

  private async retirePage(state: RendererState, candidate: RendererPageIdentity): Promise<void> {
    const page = BrowserClientPageRendererIdentity.parse(candidate)
    const reply = await this.request(state, { type: 'retirePage', page }, null)
    if (reply.type !== 'retired') {
      throw new Error(
        reply.type === 'failed' ? reply.errorCode : 'browser_client_page_retirement_failed'
      )
    }
  }

  private async rekeyPage(
    state: RendererState,
    previousCandidate: RendererPageIdentity,
    nextCandidate: RendererPageIdentity,
    signal: AbortSignal
  ): Promise<void> {
    const page = BrowserClientPageRendererIdentity.parse(previousCandidate)
    const nextPage = BrowserClientPageRendererIdentity.parse(nextCandidate)
    const reply = await this.request(state, { type: 'rekeyPage', page, nextPage }, signal)
    if (reply.type !== 'rekeyed') {
      throw new Error(
        reply.type === 'failed' ? reply.errorCode : 'browser_client_page_rekey_failed'
      )
    }
  }

  private request(
    state: RendererState,
    input: RendererRequestInput,
    signal: AbortSignal | null
  ): Promise<RendererReply> {
    if (!this.isCurrent(state)) {
      return Promise.reject(new Error('browser_client_page_renderer_stale'))
    }
    if (signal?.aborted) {
      return Promise.reject(new Error('browser_client_page_renderer_request_aborted'))
    }
    if (this.pending.size >= this.maxPending) {
      return Promise.reject(new Error('browser_client_page_renderer_request_capacity'))
    }
    const request = BrowserClientPageRendererRequest.parse({
      ...input,
      requestId: this.createRequestId()
    })
    if (this.pending.has(request.requestId)) {
      return Promise.reject(new Error('browser_client_page_renderer_request_id_conflict'))
    }
    const promise = new Promise<RendererReply>((resolve, reject) => {
      const timer = setTimeout(
        () => this.rejectPending(request.requestId, 'browser_client_page_renderer_request_timeout'),
        this.timeoutMs
      )
      timer.unref?.()
      const pending: PendingRequest = {
        state,
        request,
        signal,
        onAbort: null,
        timer,
        resolve,
        reject
      }
      if (signal) {
        pending.onAbort = () =>
          this.rejectPending(request.requestId, 'browser_client_page_renderer_request_aborted')
        signal.addEventListener('abort', pending.onAbort, { once: true })
      }
      this.pending.set(request.requestId, pending)
    })
    try {
      state.endpoint.send(BROWSER_CLIENT_PAGE_RENDERER_REQUEST_CHANNEL, request)
    } catch (error) {
      this.rejectPending(
        request.requestId,
        'browser_client_page_renderer_request_send_failed',
        error
      )
    }
    return promise
  }

  private readonly onReply: ReplyListener = (event, candidate): void => {
    const requestId = readRendererReplyRequestId(candidate)
    if (!requestId) {
      return
    }
    const pending = this.pending.get(requestId)
    if (
      !pending ||
      event.sender !== pending.state.endpoint ||
      event.senderFrame !== pending.state.frame
    ) {
      return
    }
    if (!this.isCurrent(pending.state)) {
      this.rejectPending(requestId, 'browser_client_page_renderer_stale')
      return
    }
    const parsed = BrowserClientPageRendererReply.safeParse(candidate)
    if (!parsed.success || !rendererReplyMatchesRequest(parsed.data, pending.request)) {
      this.rejectPending(requestId, 'browser_client_page_renderer_reply_invalid')
      return
    }
    this.settlePending(pending)
    pending.resolve(parsed.data)
  }

  private rejectRendererPending(state: RendererState, code: string): void {
    for (const [requestId, pending] of this.pending) {
      if (pending.state === state) {
        this.rejectPending(requestId, code)
      }
    }
  }

  private rejectPending(requestId: string, code: string, cause?: unknown): void {
    const pending = this.pending.get(requestId)
    if (!pending) {
      return
    }
    this.settlePending(pending)
    pending.reject(new Error(code, cause === undefined ? undefined : { cause }))
  }

  private settlePending(pending: PendingRequest): void {
    if (this.pending.get(pending.request.requestId) !== pending) {
      return
    }
    this.pending.delete(pending.request.requestId)
    clearTimeout(pending.timer)
    if (pending.signal && pending.onAbort) {
      pending.signal.removeEventListener('abort', pending.onAbort)
    }
  }

  private isCurrent(state: RendererState): boolean {
    return (
      !this.disposed &&
      this.current === state &&
      readCurrentRendererFrame(state.endpoint) === state.frame
    )
  }

  private assertEndpoint(
    endpoint: BrowserClientPageRendererEndpoint
  ): BrowserClientPageRendererFrame {
    const frame = readCurrentRendererFrame(endpoint)
    if (!Number.isInteger(endpoint.id) || endpoint.id <= 0 || !frame) {
      throw new Error('browser_client_page_renderer_unavailable')
    }
    return frame
  }
}
