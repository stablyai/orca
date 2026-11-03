import {
  unsubscribeSlot,
  type StreamRecord,
  type StreamManagerOptions,
  type StreamUnsubscribe
} from './mobile-relay-rpc-stream-record'
import { decodeBrowserScreencastFrame } from './browser-screencast-protocol'
import {
  handleTerminalBinaryFrame,
  type TerminalSnapshotState
} from './rpc-client-terminal-binary-frame'
import { TerminalUnreadableFrameResets } from './terminal-unreadable-frame-resets'
import {
  buildStreamUnsubscribe,
  buildTerminalUnsubscribeParams,
  updateTerminalSubscriptionViewport
} from './rpc-client-terminal-subscription'
import { buildReadyStreamUnsubscribe, isReadyIdStream } from './rpc-client-server-subscription'
import { isStreamingOpenerReply } from './rpc-acceptance-policies'
import type { RpcClient } from './rpc-client'
import type { RpcEnvelopeFields } from './rpc-envelope-fields'
import type { RpcResponse, RpcSuccess } from './types'
import { MobileTerminalMultiplexer } from './mobile-terminal-multiplexer'

function buildParamsUnsubscribe(
  method: string,
  params: unknown,
  requestId: string
): StreamUnsubscribe | null {
  if (method === 'terminal.subscribe') {
    const unsubscribeParams = buildTerminalUnsubscribeParams(params)
    return unsubscribeParams ? { method: 'terminal.unsubscribe', params: unsubscribeParams } : null
  }
  return buildStreamUnsubscribe(method, params, requestId)
}

export class MobileRelayRpcStreams {
  private readonly streams = new Map<string, StreamRecord>()
  private readonly cancelledSubscriptions = new Map<
    string,
    { method: string; unsubscribe?: StreamUnsubscribe; envelope?: RpcEnvelopeFields }
  >()
  private readonly terminalListeners = new Map<number, (result: unknown) => void>()
  private readonly terminalSnapshots = new Map<number, TerminalSnapshotState>()
  private readonly unreadableTerminalFrames = new TerminalUnreadableFrameResets()
  private activeBrowserStream: StreamRecord | null = null
  private sendCount = 0
  private readonly multiplexer: MobileTerminalMultiplexer | null

  constructor(private readonly options: StreamManagerOptions) {
    this.multiplexer = options.sendBinary
      ? new MobileTerminalMultiplexer({
          subscribe: (...args) => this.subscribeStream(...args),
          sendBinary: options.sendBinary
        })
      : null
  }

  subscribe(
    method: string,
    params: unknown,
    listener: (result: unknown) => unknown,
    subscribeOptions?: Parameters<RpcClient['subscribe']>[3]
  ): () => void {
    return (
      this.multiplexer?.subscribe(method, params, listener, subscribeOptions?.envelope) ??
      this.subscribeStream(method, params, listener, subscribeOptions)
    )
  }

  private subscribeStream(
    method: string,
    params: unknown,
    listener: (result: unknown) => unknown,
    subscribeOptions?: Parameters<RpcClient['subscribe']>[3]
  ): () => void {
    const id = this.options.nextId()
    const stream: StreamRecord = {
      method,
      params,
      envelope: subscribeOptions?.envelope,
      listener,
      onBinaryFrame: subscribeOptions?.onBinaryFrame,
      streamIds: new Set(),
      cancelled: false,
      sendOrder: null
    }
    this.streams.set(id, stream)
    void this.options
      .waitForConnected()
      .then(() => {
        if (!stream.cancelled) {
          stream.sendOrder = ++this.sendCount
          const { envelope } = stream
          if (!this.options.sendFrame({ id, method, params: stream.params, envelope })) {
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
    this.multiplexer?.updateTerminalViewport(terminal, viewport)
    updateTerminalSubscriptionViewport(this.streams.values(), terminal, viewport)
  }

  handleResponse(response: RpcResponse): boolean {
    const cancelled = this.cancelledSubscriptions.get(response.id)
    if (cancelled) {
      if (!response.ok) {
        this.cancelledSubscriptions.delete(response.id)
      } else if (response.result && typeof response.result === 'object') {
        const result = response.result as { subscriptionId?: unknown; type?: unknown }
        if (result.type === 'end') {
          this.cancelledSubscriptions.delete(response.id)
        } else if (result.type === 'snapshot' && cancelled.unsubscribe) {
          this.cancelledSubscriptions.delete(response.id)
          this.options.sendFrame({
            id: this.options.nextId(),
            ...cancelled.unsubscribe,
            envelope: cancelled.envelope
          })
        } else if (typeof result.subscriptionId === 'string') {
          this.cancelledSubscriptions.delete(response.id)
          const unsubscribe = buildReadyStreamUnsubscribe(cancelled.method, result.subscriptionId)
          if (unsubscribe) {
            this.options.sendFrame({
              id: this.options.nextId(),
              ...unsubscribe,
              envelope: cancelled.envelope
            })
          }
        }
      }
      if (response.ok && !isStreamingOpenerReply(response)) {
        this.cancelledSubscriptions.delete(response.id)
      }
      return true
    }
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
      if (stream.method === 'session.tabs.subscribe' && metadata.type === 'snapshot') {
        stream.receivedSnapshot = true
      }
      if (typeof metadata.subscriptionId === 'string') {
        stream.subscriptionId = metadata.subscriptionId
      }
      if (typeof metadata.streamId === 'number' && stream.listener) {
        stream.streamIds.add(metadata.streamId)
        this.terminalListeners.set(metadata.streamId, stream.listener)
      }
      if (stream.method === 'browser.screencast') {
        this.activeBrowserStream = stream
      }
      if (metadata.type === 'end') {
        this.finish(response.id, stream, result)
        return true
      }
    }
    if (!stream.cancelled) {
      stream.listener?.(result)
    }
    return true
  }

  handleBinary(bytes: Uint8Array): void {
    if (this.multiplexer?.handleBinary(bytes)) {
      return
    }
    const browserFrame = decodeBrowserScreencastFrame(bytes)
    if (browserFrame && this.activeBrowserStream?.onBinaryFrame) {
      this.activeBrowserStream.onBinaryFrame(browserFrame)
      return
    }
    handleTerminalBinaryFrame(bytes, {
      terminalSnapshots: this.terminalSnapshots,
      unreadableFrames: this.unreadableTerminalFrames,
      getListener: (streamId) => this.terminalListeners.get(streamId)
    })
  }

  clear(): void {
    this.multiplexer?.reset()
    for (const [id, stream] of this.streams) {
      stream.cancelled = true
      this.remove(id)
    }
    this.cancelledSubscriptions.clear()
    this.unreadableTerminalFrames.clear()
  }

  private cancel(id: string): void {
    const stream = this.streams.get(id)
    if (!stream || stream.cancelled) {
      return
    }
    stream.cancelled = true
    if (stream.sendOrder !== null) {
      const byParams = buildParamsUnsubscribe(stream.method, stream.params, id)
      if (stream.method === 'terminal.subscribe') {
        if (byParams) {
          this.sendUnsubscribe(byParams, stream.sendOrder, stream.envelope, id)
        }
      } else {
        const unsubscribe = stream.subscriptionId
          ? buildReadyStreamUnsubscribe(stream.method, stream.subscriptionId)
          : null
        if (byParams && stream.method === 'session.tabs.subscribe' && !stream.receivedSnapshot) {
          // The host registers cleanup only after resolving the initial snapshot.
          this.cancelledSubscriptions.set(id, {
            method: stream.method,
            unsubscribe: byParams,
            envelope: stream.envelope
          })
        } else if (unsubscribe || byParams) {
          this.sendUnsubscribe((unsubscribe ?? byParams)!, stream.sendOrder, stream.envelope)
        } else if (isReadyIdStream(stream.method)) {
          // Keep only the cleanup route while the server assigns its subscription ID.
          this.cancelledSubscriptions.set(id, { method: stream.method, envelope: stream.envelope })
        }
      }
    }
    this.remove(id)
  }

  /** Skip when a same-slot sibling sent later has already evicted this stream on the host. */
  private sendUnsubscribe(
    unsubscribe: StreamUnsubscribe,
    sendOrder: number,
    envelope: RpcEnvelopeFields | undefined,
    terminalRequestId?: string
  ): void {
    if (this.hasNewerSlotOwner(unsubscribe, sendOrder, envelope)) {
      return
    }
    // Check siblings first: older hosts strip requestId and would otherwise evict the live same-slot stream.
    const params = terminalRequestId
      ? { ...unsubscribe.params, requestId: terminalRequestId }
      : unsubscribe.params
    this.options.sendFrame({
      id: this.options.nextId(),
      method: unsubscribe.method,
      params,
      envelope
    })
  }

  private hasNewerSlotOwner(
    unsubscribe: StreamUnsubscribe,
    sendOrder: number,
    envelope: RpcEnvelopeFields | undefined
  ): boolean {
    const slot = unsubscribeSlot(unsubscribe, envelope)
    if (slot === null) {
      return false
    }
    for (const [siblingId, sibling] of this.streams) {
      if (sibling.cancelled || sibling.sendOrder === null || sibling.sendOrder < sendOrder) {
        continue
      }
      const siblingUnsubscribe = buildParamsUnsubscribe(sibling.method, sibling.params, siblingId)
      if (siblingUnsubscribe && unsubscribeSlot(siblingUnsubscribe, sibling.envelope) === slot) {
        return true
      }
    }
    return false
  }

  private remove(id: string): void {
    const stream = this.streams.get(id)
    if (!stream) {
      return
    }
    for (const streamId of stream.streamIds) {
      this.terminalListeners.delete(streamId)
      this.terminalSnapshots.delete(streamId)
      this.unreadableTerminalFrames.forget(streamId)
    }
    if (this.activeBrowserStream === stream) {
      this.activeBrowserStream = null
    }
    this.streams.delete(id)
    stream.listener = undefined
    stream.onBinaryFrame = undefined
  }

  private fail(id: string, stream: StreamRecord, message: string, error?: unknown): void {
    if (stream.cancelled || this.streams.get(id) !== stream) {
      return
    }
    this.finish(id, stream, { type: 'error', message, error })
  }

  /** Removed first, so the listener's dispose cannot name a host-ended stream. */
  private finish(id: string, stream: StreamRecord, result: unknown): void {
    const listener = stream.listener
    this.remove(id)
    listener?.(result)
  }
}
