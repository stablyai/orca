import { decodeBrowserScreencastFrame } from './browser-screencast-protocol'
import {
  handleTerminalBinaryFrame,
  type TerminalSnapshotState
} from './rpc-client-terminal-binary-frame'
import {
  buildStreamUnsubscribe,
  buildTerminalUnsubscribeParams,
  updateTerminalSubscriptionViewport
} from './rpc-client-terminal-subscription'
import { buildReadyStreamUnsubscribe, isReadyIdStream } from './rpc-client-server-subscription'
import { isStreamingOpenerReply } from './rpc-acceptance-policies'
import type { RpcClient } from './rpc-client'
import type { RpcResponse, RpcSuccess } from './types'
import type { ExecutionHostId } from '../../../src/shared/execution-host'

type StreamRecord = {
  method: string
  params: unknown
  listener: (result: unknown) => void
  onBinaryFrame?: Parameters<RpcClient['subscribe']>[3] extends
    | { onBinaryFrame?: infer Listener }
    | undefined
    ? Listener
    : never
  executionHost?: ExecutionHostId
  streamIds: Set<number>
  subscriptionId?: string
  cancelled: boolean
  /** Position in this session's send order, or null while unsent. */
  sendOrder: number | null
  receivedSnapshot?: boolean
}

type StreamUnsubscribe = { method: string; params: Record<string, unknown> }
type Target = ExecutionHostId | undefined
type RelayFrame = { id: string; method: string; params?: unknown }

/** The host cleanup slot an unsubscribe names; the rest of its params never identify a sibling. */
function unsubscribeSlot({ method, params }: StreamUnsubscribe, target: Target): string | null {
  if (!('subscriptionId' in params)) {
    return null
  }
  const client =
    'client' in params && typeof params.client === 'object' && params.client !== null
      ? params.client
      : null
  const clientId = client && 'id' in client ? client.id : null
  return JSON.stringify([method, params.subscriptionId, clientId, target ?? null])
}

/** Unsubscribe derived from the subscribe params alone (no server-assigned id). */
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

type StreamManagerOptions = {
  nextId: () => string
  sendFrame: (request: RelayFrame & { executionHost?: ExecutionHostId }) => boolean
  waitForConnected: () => Promise<void>
}

export class MobileRelayRpcStreams {
  private readonly streams = new Map<string, StreamRecord>()
  private readonly cancelledSubscriptions = new Map<
    string,
    { method: string; unsubscribe?: StreamUnsubscribe; target: Target }
  >()
  private readonly terminalListeners = new Map<number, (result: unknown) => void>()
  private readonly terminalSnapshots = new Map<number, TerminalSnapshotState>()
  private activeBrowserStream: StreamRecord | null = null
  private sendCount = 0

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
      executionHost: subscribeOptions?.executionHost,
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
          if (!this.send({ id, method, params: stream.params }, stream.executionHost)) {
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
          this.send({ id: this.options.nextId(), ...cancelled.unsubscribe }, cancelled.target)
        } else if (typeof result.subscriptionId === 'string') {
          this.cancelledSubscriptions.delete(response.id)
          const unsubscribe = buildReadyStreamUnsubscribe(cancelled.method, result.subscriptionId)
          if (unsubscribe) {
            this.send({ id: this.options.nextId(), ...unsubscribe }, cancelled.target)
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
      if (typeof metadata.streamId === 'number') {
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
    for (const stream of this.streams.values()) {
      stream.cancelled = true
    }
    this.streams.clear()
    this.cancelledSubscriptions.clear()
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
    if (stream.sendOrder !== null) {
      const byParams = buildParamsUnsubscribe(stream.method, stream.params, id)
      if (stream.method === 'terminal.subscribe') {
        if (byParams) {
          this.sendUnsubscribe(byParams, stream.sendOrder, stream.executionHost, id)
        }
      } else {
        const target = stream.executionHost
        const unsubscribe = stream.subscriptionId
          ? buildReadyStreamUnsubscribe(stream.method, stream.subscriptionId)
          : null
        if (byParams && stream.method === 'session.tabs.subscribe' && !stream.receivedSnapshot) {
          // The host registers cleanup only after resolving the initial snapshot.
          this.cancelledSubscriptions.set(id, {
            method: stream.method,
            unsubscribe: byParams,
            target
          })
        } else if (unsubscribe || byParams) {
          this.sendUnsubscribe((unsubscribe ?? byParams)!, stream.sendOrder, target)
        } else if (isReadyIdStream(stream.method)) {
          // Keep only the cleanup route while the server assigns its subscription ID.
          this.cancelledSubscriptions.set(id, { method: stream.method, target })
        }
      }
    }
    this.remove(id)
  }

  /** Skip when a same-slot sibling sent later has already evicted this stream on the host. */
  private sendUnsubscribe(
    unsubscribe: StreamUnsubscribe,
    sendOrder: number,
    target: Target,
    terminalRequestId?: string
  ): void {
    if (this.hasNewerSlotOwner(unsubscribe, sendOrder, target)) {
      return
    }
    // Why: added after the sibling check; an old host strips it and would evict the live sibling.
    const params = terminalRequestId
      ? { ...unsubscribe.params, requestId: terminalRequestId }
      : unsubscribe.params
    const frame = { id: this.options.nextId(), method: unsubscribe.method, params }
    this.send(frame, target)
  }

  private hasNewerSlotOwner(
    unsubscribe: StreamUnsubscribe,
    sendOrder: number,
    target: Target
  ): boolean {
    const slot = unsubscribeSlot(unsubscribe, target)
    if (slot === null) {
      return false
    }
    for (const [siblingId, sibling] of this.streams) {
      if (sibling.cancelled || sibling.sendOrder === null || sibling.sendOrder < sendOrder) {
        continue
      }
      const siblingUnsubscribe = buildParamsUnsubscribe(sibling.method, sibling.params, siblingId)
      if (
        siblingUnsubscribe &&
        unsubscribeSlot(siblingUnsubscribe, sibling.executionHost) === slot
      ) {
        return true
      }
    }
    return false
  }

  /** Every frame about a stream names the host it runs on. */
  private send(frame: RelayFrame, target: Target): boolean {
    return this.options.sendFrame(target ? { ...frame, executionHost: target } : frame)
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

  private fail(id: string, stream: StreamRecord, message: string, error?: unknown): void {
    if (stream.cancelled || this.streams.get(id) !== stream) {
      return
    }
    this.finish(id, stream, { type: 'error', message, error })
  }

  /** Removed first, so the listener's dispose cannot name a host-ended stream. */
  private finish(id: string, stream: StreamRecord, result: unknown): void {
    this.remove(id)
    stream.listener(result)
  }
}
