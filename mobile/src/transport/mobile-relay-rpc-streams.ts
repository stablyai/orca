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
}

export class MobileRelayRpcStreams {
  private readonly streams = new Map<string, StreamRecord>()
  private readonly terminalListeners = new Map<number, (result: unknown) => void>()
  private readonly terminalSnapshots = new Map<number, TerminalSnapshotState>()
  private activeBrowserStream: StreamRecord | null = null

  constructor(private readonly options: StreamManagerOptions) {}

  subscribe(
    method: string,
    params: unknown,
    listener: (result: unknown) => void,
    subscribeOptions?: Parameters<RpcClient['subscribe']>[3]
  ): () => void {
    const id = this.options.nextId()
    const stream: StreamRecord = {
      method,
      params,
      listener,
      onBinaryFrame: subscribeOptions?.onBinaryFrame,
      streamIds: new Set(),
      cancelled: false
    }
    this.streams.set(id, stream)
    void this.options
      .waitForConnected()
      .then(() => {
        if (!stream.cancelled && !this.options.sendFrame({ id, method, params: stream.params })) {
          this.remove(id)
        }
      })
      .catch(() => this.remove(id))
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
      this.remove(response.id)
      return true
    }
    const result = (response as RpcSuccess).result
    if (result && typeof result === 'object') {
      const metadata = result as { subscriptionId?: unknown; streamId?: unknown; type?: unknown }
      if (typeof metadata.subscriptionId === 'string') {
        stream.subscriptionId = metadata.subscriptionId
      }
      if (typeof metadata.streamId === 'number') {
        stream.streamIds.add(metadata.streamId)
        this.terminalListeners.set(metadata.streamId, stream.listener)
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
      getListener: (streamId) => this.terminalListeners.get(streamId),
      recordValidatedInboundTraffic: () => {}
    })
  }

  clear(): void {
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
}
