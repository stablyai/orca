import {
  BROWSER_CLIENT_PAGE_RENDERER_REPLY_CHANNEL,
  BROWSER_CLIENT_PAGE_RENDERER_REQUEST_CHANNEL,
  BrowserClientPageRendererOutcome,
  BrowserClientPageRendererReply,
  BrowserClientPageRendererRequest,
  type BrowserClientPageRendererOutcome as RendererOutcome,
  type BrowserClientPageRendererRequest as RendererRequest
} from '../shared/browser-client-page-renderer-protocol'

const DEFAULT_MAX_PENDING = 512
const DEFAULT_TIMEOUT_MS = 10_000

type RequestListener = (event: unknown, request: unknown) => void

type RendererRequestIpc = {
  on(channel: string, listener: RequestListener): void
  removeListener(channel: string, listener: RequestListener): void
  send(channel: string, payload: unknown): void
}

type RendererRequestCallback = (
  request: RendererRequest
) => RendererOutcome | Promise<RendererOutcome>

type PendingRequest = {
  request: RendererRequest
  subscriberGeneration: number | null
  timer: ReturnType<typeof setTimeout>
}

export function createBrowserClientPageRendererRequests(options: {
  ipc: RendererRequestIpc
  isTopFrame: () => boolean
  maxPending?: number
  timeoutMs?: number
}): {
  dispose(): void
  subscribe(callback: RendererRequestCallback): () => void
} {
  return new BrowserClientPageRendererRequests(options)
}

class BrowserClientPageRendererRequests {
  private readonly maxPending: number
  private readonly timeoutMs: number
  private readonly pending = new Map<string, PendingRequest>()
  private readonly queuedRequestIds: string[] = []
  private callback: RendererRequestCallback | null = null
  private subscriberGeneration = 0
  private readonly topFrame: boolean
  private disposed = false

  constructor(
    private readonly options: {
      ipc: RendererRequestIpc
      isTopFrame: () => boolean
      maxPending?: number
      timeoutMs?: number
    }
  ) {
    this.maxPending = options.maxPending ?? DEFAULT_MAX_PENDING
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    if (
      !Number.isInteger(this.maxPending) ||
      this.maxPending < 1 ||
      !Number.isFinite(this.timeoutMs) ||
      this.timeoutMs <= 0
    ) {
      throw new Error('browser_client_page_renderer_preload_limits_invalid')
    }
    this.topFrame = readTopFrame(options.isTopFrame)
    if (this.topFrame) {
      options.ipc.on(BROWSER_CLIENT_PAGE_RENDERER_REQUEST_CHANNEL, this.onRequest)
    }
  }

  subscribe = (callback: RendererRequestCallback): (() => void) => {
    if (!this.topFrame) {
      throw new Error('browser_client_page_renderer_top_frame_required')
    }
    if (this.disposed) {
      throw new Error('browser_client_page_renderer_preload_disposed')
    }
    if (typeof callback !== 'function') {
      throw new Error('browser_client_page_renderer_subscriber_invalid')
    }
    const replacedGeneration = this.callback ? this.subscriberGeneration : null
    const generation = ++this.subscriberGeneration
    this.callback = callback
    if (replacedGeneration !== null) {
      this.failSubscriberRequests(
        replacedGeneration,
        'browser_client_page_renderer_subscriber_replaced'
      )
    }
    const queued = this.queuedRequestIds.splice(0)
    for (const requestId of queued) {
      this.dispatch(requestId, generation, callback)
    }

    return () => {
      if (this.callback !== callback || this.subscriberGeneration !== generation) {
        return
      }
      this.callback = null
      this.failSubscriberRequests(generation, 'browser_client_page_renderer_subscriber_unavailable')
    }
  }

  dispose(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    this.callback = null
    if (this.topFrame) {
      this.options.ipc.removeListener(BROWSER_CLIENT_PAGE_RENDERER_REQUEST_CHANNEL, this.onRequest)
    }
    for (const pending of this.pending.values()) {
      this.fail(pending, 'browser_client_page_renderer_preload_disposed')
    }
    this.queuedRequestIds.length = 0
  }

  private readonly onRequest: RequestListener = (_event, candidate): void => {
    if (this.disposed) {
      return
    }
    const parsed = BrowserClientPageRendererRequest.safeParse(candidate)
    if (!parsed.success || this.pending.has(parsed.data.requestId)) {
      return
    }
    const request = freezeRequest(parsed.data)
    if (this.pending.size >= this.maxPending) {
      this.sendFailed(request, 'browser_client_page_renderer_request_capacity')
      return
    }
    const timer = setTimeout(() => {
      const pending = this.pending.get(request.requestId)
      if (pending) {
        this.fail(pending, 'browser_client_page_renderer_subscriber_timeout')
      }
    }, this.timeoutMs)
    timer.unref?.()
    const pending: PendingRequest = { request, subscriberGeneration: null, timer }
    this.pending.set(request.requestId, pending)
    const callback = this.callback
    if (!callback) {
      this.queuedRequestIds.push(request.requestId)
      return
    }
    this.dispatch(request.requestId, this.subscriberGeneration, callback)
  }

  private dispatch(
    requestId: string,
    subscriberGeneration: number,
    callback: RendererRequestCallback
  ): void {
    const pending = this.pending.get(requestId)
    if (!pending || pending.subscriberGeneration !== null) {
      return
    }
    pending.subscriberGeneration = subscriberGeneration
    void Promise.resolve()
      .then(() => callback(pending.request))
      .then(
        (outcome) => this.onOutcome(pending, subscriberGeneration, outcome),
        () => this.failCurrent(pending, 'browser_client_page_renderer_handler_failed')
      )
  }

  private onOutcome(
    pending: PendingRequest,
    subscriberGeneration: number,
    candidate: unknown
  ): void {
    if (
      this.pending.get(pending.request.requestId) !== pending ||
      pending.subscriberGeneration !== subscriberGeneration
    ) {
      return
    }
    const outcome = BrowserClientPageRendererOutcome.safeParse(candidate)
    if (!outcome.success || !outcomeMatchesRequest(outcome.data, pending.request)) {
      this.fail(pending, 'browser_client_page_renderer_result_invalid')
      return
    }
    this.settle(pending)
    this.sendReply(pending.request, outcome.data)
  }

  private failSubscriberRequests(generation: number, errorCode: string): void {
    for (const pending of this.pending.values()) {
      if (pending.subscriberGeneration === generation) {
        this.fail(pending, errorCode)
      }
    }
  }

  private failCurrent(pending: PendingRequest, errorCode: string): void {
    if (this.pending.get(pending.request.requestId) === pending) {
      this.fail(pending, errorCode)
    }
  }

  private fail(pending: PendingRequest, errorCode: string): void {
    this.settle(pending)
    this.sendFailed(pending.request, errorCode)
  }

  private settle(pending: PendingRequest): void {
    if (this.pending.get(pending.request.requestId) !== pending) {
      return
    }
    this.pending.delete(pending.request.requestId)
    clearTimeout(pending.timer)
    if (pending.subscriberGeneration === null) {
      const queuedIndex = this.queuedRequestIds.indexOf(pending.request.requestId)
      if (queuedIndex !== -1) {
        this.queuedRequestIds.splice(queuedIndex, 1)
      }
    }
  }

  private sendFailed(request: RendererRequest, errorCode: string): void {
    this.sendReply(request, { type: 'failed', errorCode })
  }

  private sendReply(request: RendererRequest, outcome: RendererOutcome): void {
    const nextPage = request.type === 'rekeyPage' ? { nextPage: request.nextPage } : {}
    const reply = BrowserClientPageRendererReply.safeParse(
      outcome.type === 'failed'
        ? {
            ...outcome,
            requestId: request.requestId,
            page: request.page,
            operation: request.type
          }
        : { ...outcome, requestId: request.requestId, page: request.page, ...nextPage }
    )
    if (!reply.success) {
      return
    }
    try {
      this.options.ipc.send(BROWSER_CLIENT_PAGE_RENDERER_REPLY_CHANNEL, reply.data)
    } catch {}
  }
}

function readTopFrame(isTopFrame: () => boolean): boolean {
  try {
    return isTopFrame()
  } catch {
    return false
  }
}

function freezeRequest(request: RendererRequest): RendererRequest {
  return Object.freeze({
    ...request,
    page: Object.freeze({ ...request.page }),
    ...(request.type === 'rekeyPage' ? { nextPage: Object.freeze({ ...request.nextPage }) } : {})
  })
}

function outcomeMatchesRequest(outcome: RendererOutcome, request: RendererRequest): boolean {
  return (
    outcome.type === 'failed' ||
    (request.type === 'mountPage' && outcome.type === 'mounted') ||
    (request.type === 'retirePage' && outcome.type === 'retired') ||
    (request.type === 'rekeyPage' && outcome.type === 'rekeyed')
  )
}
