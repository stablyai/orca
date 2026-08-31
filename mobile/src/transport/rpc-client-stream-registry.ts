import {
  decodeBrowserScreencastFrame,
  type BrowserScreencastFrame
} from './browser-screencast-protocol'
import {
  buildStreamUnsubscribe,
  buildTerminalUnsubscribeParams,
  updateTerminalSubscriptionViewport
} from './rpc-client-terminal-subscription'
import { buildReadyStreamUnsubscribe } from './rpc-client-server-subscription'
import {
  isStreamingSubscriptionReadyResult,
  isTerminalSubscribedResult
} from './rpc-subscription-result-shapes'
import { RpcClientTerminalStreamRouter } from './rpc-client-terminal-stream-router'
import type { ConnectionState, RpcResponse, RpcSuccess } from './types'

export type RpcStreamingListener = (result: unknown) => void

export type RpcStreamSubscribeOptions = {
  onBinaryFrame?: (frame: BrowserScreencastFrame) => void
}

type StreamRequest = {
  method: string
  params: unknown
  listener: RpcStreamingListener
  onBinaryFrame?: (frame: BrowserScreencastFrame) => void
  subscriptionId?: string
  cancelled?: boolean
  sent?: boolean
}

type StreamRegistryOptions = {
  nextId: () => string
  deviceToken: string
  getState: () => ConnectionState
  sendEncrypted: (request: unknown) => boolean
}

export class RpcClientStreamRegistry {
  private readonly streams = new Map<string, StreamRequest>()
  private readonly terminalRouter = new RpcClientTerminalStreamRouter()
  private activeBrowserRequestId: string | null = null
  private pendingBrowserRequestId: string | null = null

  constructor(private readonly options: StreamRegistryOptions) {}

  subscribe(
    method: string,
    params: unknown,
    listener: RpcStreamingListener,
    subscribeOptions?: RpcStreamSubscribeOptions
  ): () => void {
    const id = this.options.nextId()
    const stream: StreamRequest = {
      method,
      params,
      listener,
      onBinaryFrame: subscribeOptions?.onBinaryFrame
    }
    this.streams.set(id, stream)
    if (method === 'browser.screencast') {
      this.replaceBrowserStream(id)
    }
    if (this.options.getState() === 'connected') {
      if (this.send(id, stream)) {
        stream.sent = true
      } else {
        this.emitError(stream, 'Connection interrupted')
        this.remove(id)
      }
    } else {
      console.log('[net] subscribe queued — waiting for connected', {
        method,
        state: this.options.getState()
      })
    }
    return () => this.dispose(id)
  }

  replayAfterAuthentication(): void {
    for (const [id, stream] of this.streams) {
      if (stream.cancelled) {
        this.remove(id)
        continue
      }
      if (stream.sent) {
        continue
      }
      if (stream.method === 'browser.screencast') {
        this.pendingBrowserRequestId = id
        this.activeBrowserRequestId = null
      }
      this.resetTerminalRouting(id)
      if (this.send(id, stream)) {
        stream.sent = true
      } else {
        this.markForReplay()
        break
      }
    }
  }

  markForReplay(): void {
    this.activeBrowserRequestId = null
    this.pendingBrowserRequestId = null
    for (const [id, stream] of this.streams) {
      stream.sent = false
      this.resetTerminalRouting(id)
    }
  }

  handleResponse(response: RpcResponse): boolean {
    if (response.ok && response.streaming === true) {
      this.handleStreamingResponse(response)
      return true
    }
    const stream = this.streams.get(response.id)
    if (response.ok) {
      const result = (response as RpcSuccess).result as Record<string, unknown> | null
      if (stream && result?.type === 'end') {
        if (!stream.cancelled) {
          stream.listener(result)
        }
        this.remove(response.id)
        return true
      }
      if (stream && result?.type === 'scrollback') {
        stream.listener(result)
        return true
      }
    }
    if (!stream) {
      return false
    }
    this.emitError(
      stream,
      response.ok ? 'Streaming request ended before it was ready.' : response.error.message,
      response.ok ? undefined : response.error
    )
    this.remove(response.id)
    return true
  }

  handleBinary(bytes: Uint8Array): void {
    const browserFrame = decodeBrowserScreencastFrame(bytes)
    if (browserFrame) {
      this.handleBrowserFrame(browserFrame)
      return
    }
    this.terminalRouter.handle(bytes)
  }

  updateTerminalViewport(terminal: string, viewport: { cols: number; rows: number }): void {
    updateTerminalSubscriptionViewport(this.streams.values(), terminal, viewport)
  }

  size(): number {
    return this.streams.size
  }

  private handleStreamingResponse(response: RpcSuccess): void {
    const stream = this.streams.get(response.id)
    if (!stream) {
      return
    }
    const result = response.result
    if (isStreamingSubscriptionReadyResult(result)) {
      stream.subscriptionId = result.subscriptionId
      if (stream.cancelled) {
        this.sendServerSubscriptionUnsubscribe(stream)
        this.remove(response.id)
        return
      }
      if (stream.method === 'browser.screencast') {
        if (
          this.pendingBrowserRequestId !== response.id &&
          this.activeBrowserRequestId !== response.id
        ) {
          this.sendBrowserUnsubscribe(result.subscriptionId)
          this.remove(response.id)
          return
        }
        this.pendingBrowserRequestId = null
        this.activeBrowserRequestId = response.id
      }
    }
    if (isTerminalSubscribedResult(result)) {
      this.terminalRouter.register(response.id, result.streamId, stream.listener)
    }
    if (!stream.cancelled) {
      stream.listener(result)
    }
  }

  private dispose(id: string): void {
    const stream = this.streams.get(id)
    if (stream?.method === 'browser.screencast') {
      stream.cancelled = true
      this.clearBrowserRequest(id)
      this.disposeServerSubscription(id, stream)
      return
    }
    if (stream?.method === 'runtime.clientEvents.subscribe') {
      this.disposeServerSubscription(id, stream)
      return
    }
    if (stream?.method === 'terminal.subscribe') {
      const params = buildTerminalUnsubscribeParams(stream.params)
      if (params) {
        this.sendRpc('terminal.unsubscribe', params)
      }
    } else {
      const unsubscribe = buildStreamUnsubscribe(stream?.method, stream?.params)
      if (unsubscribe) {
        this.sendRpc(unsubscribe.method, unsubscribe.params)
      }
    }
    this.remove(id)
  }

  private replaceBrowserStream(id: string): void {
    if (this.activeBrowserRequestId && this.activeBrowserRequestId !== id) {
      this.dispose(this.activeBrowserRequestId)
    }
    if (this.pendingBrowserRequestId && this.pendingBrowserRequestId !== id) {
      this.dispose(this.pendingBrowserRequestId)
    }
    this.pendingBrowserRequestId = id
    this.activeBrowserRequestId = null
  }

  private disposeServerSubscription(id: string, stream: StreamRequest): void {
    stream.cancelled = true
    if (stream.subscriptionId) {
      this.sendServerSubscriptionUnsubscribe(stream)
      this.remove(id)
    } else if (!stream.sent) {
      this.remove(id)
    }
  }

  private sendServerSubscriptionUnsubscribe(stream: StreamRequest): void {
    if (!stream.subscriptionId) {
      return
    }
    const unsubscribe = buildReadyStreamUnsubscribe(stream.method, stream.subscriptionId)
    if (unsubscribe) {
      this.sendRpc(unsubscribe.method, unsubscribe.params)
    }
  }

  private sendBrowserUnsubscribe(subscriptionId: string): void {
    this.sendRpc('browser.screencast.unsubscribe', { subscriptionId })
  }

  private sendRpc(method: string, params: unknown): boolean {
    return this.options.sendEncrypted({
      id: this.options.nextId(),
      deviceToken: this.options.deviceToken,
      method,
      params
    })
  }

  private send(id: string, stream: StreamRequest): boolean {
    return this.options.sendEncrypted({
      id,
      deviceToken: this.options.deviceToken,
      method: stream.method,
      params: stream.params
    })
  }

  private remove(id: string): void {
    const stream = this.streams.get(id)
    this.streams.delete(id)
    this.clearBrowserRequest(id)
    this.resetTerminalRouting(id)
    if (stream?.method === 'browser.screencast') {
      stream.cancelled = true
    }
  }

  private clearBrowserRequest(id: string): void {
    if (this.activeBrowserRequestId === id) {
      this.activeBrowserRequestId = null
    }
    if (this.pendingBrowserRequestId === id) {
      this.pendingBrowserRequestId = null
    }
  }

  private resetTerminalRouting(id: string): void {
    this.terminalRouter.reset(id)
  }

  private handleBrowserFrame(frame: BrowserScreencastFrame): void {
    if (!this.activeBrowserRequestId) {
      return
    }
    const stream = this.streams.get(this.activeBrowserRequestId)
    if (!stream || stream.cancelled || stream.method !== 'browser.screencast') {
      return
    }
    stream.onBinaryFrame?.(frame)
  }

  private emitError(stream: StreamRequest, message: string, error?: unknown): void {
    if (!stream.cancelled) {
      stream.listener({ type: 'error', message, error })
    }
  }
}
