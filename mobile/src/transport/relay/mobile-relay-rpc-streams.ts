// The phone's relay streams: the shared stream core, plus the terminal and screencast frames that
// arrive as binary and are routed by the stream ids their opener replies name.
import { decodeBrowserScreencastFrame } from '../../browser/screencast/browser-screencast-protocol'
import {
  handleTerminalBinaryFrame,
  type TerminalSnapshotState
} from '../rpc/rpc-client-terminal-binary-frame'
import { TerminalUnreadableFrameResets } from '../rpc/terminal-unreadable-frame-resets'
import {
  buildTerminalUnsubscribeParams,
  updateTerminalSubscriptionViewport
} from '../rpc/rpc-client-terminal-subscription'
import { RelayRpcStreams } from '../../../../src/shared/remote-runtime/relay/client/relay-rpc-streams'
import type { RpcClient } from '../rpc/rpc-client-contract'
import type { RpcEnvelopeFields, RpcRequestFrame } from '../rpc/rpc-envelope-fields'
import type { RpcResponse } from '../rpc/rpc-wire-types'

type BinaryFrameListener = Parameters<RpcClient['subscribe']>[3] extends
  | { onBinaryFrame?: infer Listener }
  | undefined
  ? Listener
  : never

type StreamManagerOptions = {
  nextId: () => string
  sendFrame: (frame: RpcRequestFrame) => boolean
  waitForConnected: () => Promise<void>
}

export class MobileRelayRpcStreams {
  private readonly core: RelayRpcStreams<RpcEnvelopeFields>
  private readonly binaryListeners = new Map<string, BinaryFrameListener>()
  private readonly terminalStreamIds = new Map<string, Set<number>>()
  private readonly terminalListeners = new Map<number, (result: unknown) => void>()
  private readonly terminalSnapshots = new Map<number, TerminalSnapshotState>()
  private readonly unreadableTerminalFrames = new TerminalUnreadableFrameResets()
  private activeBrowserStreamId: string | null = null

  constructor(options: StreamManagerOptions) {
    this.core = new RelayRpcStreams<RpcEnvelopeFields>({
      ...options,
      requestBoundUnsubscribe: (method, params) => {
        const unsubscribeParams =
          method === 'terminal.subscribe' ? buildTerminalUnsubscribeParams(params) : null
        return unsubscribeParams
          ? { method: 'terminal.unsubscribe', params: unsubscribeParams }
          : null
      },
      onOpenerResult: (id, stream, result) => {
        const { streamId } = result as { streamId?: unknown }
        if (typeof streamId === 'number' && stream.listener) {
          const ids = this.terminalStreamIds.get(id) ?? new Set<number>()
          ids.add(streamId)
          this.terminalStreamIds.set(id, ids)
          this.terminalListeners.set(streamId, stream.listener)
        }
        if (stream.method === 'browser.screencast') {
          this.activeBrowserStreamId = id
        }
      },
      onRemoved: (id) => {
        for (const streamId of this.terminalStreamIds.get(id) ?? []) {
          this.terminalListeners.delete(streamId)
          this.terminalSnapshots.delete(streamId)
          this.unreadableTerminalFrames.forget(streamId)
        }
        this.terminalStreamIds.delete(id)
        this.binaryListeners.delete(id)
        if (this.activeBrowserStreamId === id) {
          this.activeBrowserStreamId = null
        }
      }
    })
  }

  subscribe(
    method: string,
    params: unknown,
    listener: (result: unknown) => void,
    subscribeOptions?: Parameters<RpcClient['subscribe']>[3]
  ): () => void {
    const { id, release } = this.core.subscribe(
      method,
      params,
      listener,
      subscribeOptions?.envelope
    )
    if (subscribeOptions?.onBinaryFrame) {
      this.binaryListeners.set(id, subscribeOptions.onBinaryFrame)
    }
    return release
  }

  updateTerminalViewport(terminal: string, viewport: { cols: number; rows: number }): void {
    updateTerminalSubscriptionViewport(this.core.values(), terminal, viewport)
  }

  handleResponse(response: RpcResponse): boolean {
    return this.core.handleResponse(response)
  }

  handleBinary(bytes: Uint8Array): void {
    const browserFrame = decodeBrowserScreencastFrame(bytes)
    const browserListener =
      this.activeBrowserStreamId === null
        ? undefined
        : this.binaryListeners.get(this.activeBrowserStreamId)
    if (browserFrame && browserListener) {
      browserListener(browserFrame)
      return
    }
    handleTerminalBinaryFrame(bytes, {
      terminalSnapshots: this.terminalSnapshots,
      unreadableFrames: this.unreadableTerminalFrames,
      getListener: (streamId) => this.terminalListeners.get(streamId)
    })
  }

  clear(): void {
    this.core.clear()
    this.unreadableTerminalFrames.clear()
  }
}
