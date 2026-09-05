import { decodeBrowserScreencastFrame } from './browser-screencast-protocol'
import {
  handleTerminalBinaryFrame,
  type TerminalSnapshotState
} from './rpc-client-terminal-binary-frame'
import {
  buildTerminalUnsubscribeParams,
  updateTerminalSubscriptionViewport
} from './rpc-client-terminal-subscription'
import type { RpcClient } from './rpc-client'
import type { RpcResponse, RpcSuccess } from './types'
import { TerminalOrderedInput, advertiseTerminalOrderedInput } from './terminal-ordered-input'

type StreamRecord = {
  method: string
  params: unknown
  listener: (result: unknown) => void
  onBinaryFrame?: Parameters<RpcClient['subscribe']>[3] extends
    | { onBinaryFrame?: infer Listener }
    | undefined
    ? Listener
    : never
  streamIds: Set<number>
  subscriptionId?: string
  cancelled: boolean
}

type StreamManagerOptions = {
  nextId: () => string
  sendFrame: (request: { id: string; method: string; params?: unknown }) => boolean
  waitForConnected: () => Promise<void>
  sendBinary?: (bytes: Uint8Array) => boolean
}

export class MobileRelayRpcStreams {
  private readonly streams = new Map<string, StreamRecord>()
  private readonly terminalListeners = new Map<number, (result: unknown) => void>()
  private readonly terminalSnapshots = new Map<number, TerminalSnapshotState>()
  private activeBrowserStream: StreamRecord | null = null
  private readonly orderedInput: TerminalOrderedInput

  constructor(private readonly options: StreamManagerOptions) {
    this.orderedInput = new TerminalOrderedInput((bytes) => options.sendBinary?.(bytes) ?? false)
  }

  sendTerminalStreamInput(terminal: string, text: string): Promise<boolean> | null {
    return this.orderedInput.send(terminal, text)
  }
  getTerminalStreamInputFailure = (terminal: string) => this.orderedInput.failure(terminal)
  recoverTerminalStreamInput = (terminal: string) => this.orderedInput.recover(terminal)
  cancelTerminalStreamInput(terminal: string): void {
    for (const id of this.orderedInput.cancel(terminal)) {
      this.cancel(id)
    }
  }

  supportsTerminalStreamInput(terminal: string): boolean {
    return this.orderedInput.supports(terminal)
  }

  subscribe(
    method: string,
    params: unknown,
    listener: (result: unknown) => void,
    subscribeOptions?: Parameters<RpcClient['subscribe']>[3]
  ): () => void {
    const id = this.options.nextId()
    const stream: StreamRecord = {
      method,
      params: advertiseTerminalOrderedInput(method, params),
      listener,
      onBinaryFrame: subscribeOptions?.onBinaryFrame,
      streamIds: new Set(),
      cancelled: false
    }
    this.streams.set(id, stream)
    void this.options
      .waitForConnected()
      .then(() => {
        if (!stream.cancelled) {
          if (!this.options.sendFrame({ id, method, params: stream.params })) {
            this.fail(id, stream, 'Connection interrupted')
          }
        }
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : 'Connection interrupted'
        this.fail(id, stream, message, error)
      })
    return () => this.cancel(id)
  }

  updateTerminalViewport(terminal: string, viewport: { cols: number; rows: number }): void {
    updateTerminalSubscriptionViewport(this.streams.values(), terminal, viewport)
  }

  handleResponse(response: RpcResponse): boolean {
    const stream = this.streams.get(response.id)
    if (!stream) {
      return false
    }
    if (!response.ok) {
      this.fail(response.id, stream, response.error.message, response.error)
      return true
    }
    const result = (response as RpcSuccess).result
    if (result && typeof result === 'object') {
      const metadata = result as { subscriptionId?: unknown; streamId?: unknown; type?: unknown }
      if (typeof metadata.subscriptionId === 'string') {
        stream.subscriptionId = metadata.subscriptionId
      }
      if (typeof metadata.streamId === 'number') {
        const streamId = metadata.streamId
        this.orderedInput.register(response.id, stream.params, result)
        stream.streamIds.add(metadata.streamId)
        this.terminalListeners.set(metadata.streamId, (event) => {
          this.orderedInput.handle(streamId, event)
          stream.listener(event)
        })
      }
      if (stream.method === 'browser.screencast') {
        this.activeBrowserStream = stream
      }
      if (metadata.type === 'end') {
        stream.listener(result)
        this.remove(response.id)
        return true
      }
    }
    if (!stream.cancelled) {
      stream.listener(result)
    }
    return true
  }

  handleBinary(bytes: Uint8Array): void {
    const browserFrame = decodeBrowserScreencastFrame(bytes)
    if (browserFrame && this.activeBrowserStream?.onBinaryFrame) {
      this.activeBrowserStream.onBinaryFrame(browserFrame)
      return
    }
    handleTerminalBinaryFrame(bytes, {
      terminalSnapshots: this.terminalSnapshots,
      getListener: (streamId) => this.terminalListeners.get(streamId)
    })
  }

  clear(): void {
    this.orderedInput.clear()
    for (const stream of this.streams.values()) {
      stream.cancelled = true
    }
    this.streams.clear()
    this.terminalListeners.clear()
    this.terminalSnapshots.clear()
    this.activeBrowserStream = null
  }

  private cancel(id: string): void {
    const stream = this.streams.get(id)
    if (!stream || stream.cancelled) {
      return
    }
    stream.cancelled = true
    if (stream.method === 'terminal.subscribe') {
      const params = buildTerminalUnsubscribeParams(stream.params)
      if (params) {
        this.options.sendFrame({
          id: this.options.nextId(),
          method: 'terminal.unsubscribe',
          params
        })
      }
    } else if (stream.subscriptionId) {
      this.options.sendFrame({
        id: this.options.nextId(),
        method: stream.method.replace(/\.subscribe$/, '.unsubscribe'),
        params: { subscriptionId: stream.subscriptionId }
      })
    }
    this.remove(id)
  }

  private remove(id: string): void {
    this.orderedInput.reset(id)
    const stream = this.streams.get(id)
    if (!stream) {
      return
    }
    for (const streamId of stream.streamIds) {
      this.terminalListeners.delete(streamId)
      this.terminalSnapshots.delete(streamId)
    }
    if (this.activeBrowserStream === stream) {
      this.activeBrowserStream = null
    }
    this.streams.delete(id)
  }

  private fail(id: string, stream: StreamRecord, message: string, error?: unknown): void {
    if (stream.cancelled || this.streams.get(id) !== stream) {
      return
    }
    try {
      stream.listener({ type: 'error', message, error })
    } finally {
      this.remove(id)
    }
  }
}
