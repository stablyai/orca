import {
  BROWSER_NETWORK_TUNNEL_MAX_DATA_BYTES,
  BrowserNetworkTunnelOpcode,
  decodeBrowserNetworkTunnelFrame,
  decodeBrowserNetworkTunnelWindowUpdate,
  encodeBrowserNetworkTunnelFrame,
  encodeBrowserNetworkTunnelOpen,
  encodeBrowserNetworkTunnelWindowUpdate,
  type BrowserNetworkTunnelFrame,
  type BrowserNetworkTunnelOpen
} from '../../../src/shared/browser-network-tunnel-protocol'
import type { MobileBrowserTunnelEvent } from '../../../src/shared/mobile-browser-tunnel-protocol'
import type { BrowserTunnelFrameChannel } from '../transport/browser-tunnel-frame-channel'

// Matches the host session's window: credit beyond it is a protocol error.
const RECEIVE_WINDOW_BYTES = 256 * 1024
const MAX_STREAMS = 128

export type MobileBrowserTunnelStreamSink = {
  opened: () => void
  data: (bytes: Uint8Array) => void
  // The destination finished sending; the page may still write.
  end: () => void
  closed: (reason?: string) => void
}

export type MobileBrowserTunnelStream = {
  write: (bytes: Uint8Array) => void
  // The page finished sending.
  end: () => void
  close: () => void
}

type StreamState = {
  id: number | null
  target: BrowserNetworkTunnelOpen
  sink: MobileBrowserTunnelStreamSink
  sendCredit: number
  pending: Uint8Array[]
  endRequested: boolean
  halfCloseSent: boolean
}

type MobileBrowserTunnelClientOptions = {
  channel: BrowserTunnelFrameChannel
  // Subscribes to network.mobileBrowserTunnel; the subscription replays on every new socket.
  subscribe: (onEvent: (event: MobileBrowserTunnelEvent) => void) => () => void
  // The host closed the tunnel and ended the subscription; nothing reopens it on this socket.
  onClosed?: () => void
}

/** Carries the phone web view's proxy connections to the host over the tunnel frames desktop uses. */
export class MobileBrowserTunnelClient {
  private generation: number | null = null
  private nextStreamId = 1
  private readonly streams = new Map<number, StreamState>()
  private readonly queued = new Set<StreamState>()
  private readonly unsubscribe: () => void
  private readonly unlisten: () => void
  private closed = false
  // Set by the host's closed event until a new socket replays the subscription.
  private hostClosed = false

  constructor(private readonly options: MobileBrowserTunnelClientOptions) {
    this.unlisten = options.channel.onFrame((bytes) => this.handleFrame(bytes))
    this.unsubscribe = options.subscribe((event) => this.handleEvent(event))
  }

  open(
    target: BrowserNetworkTunnelOpen,
    sink: MobileBrowserTunnelStreamSink
  ): MobileBrowserTunnelStream {
    const state: StreamState = {
      id: null,
      target,
      sink,
      sendCredit: 0,
      pending: [],
      endRequested: false,
      halfCloseSent: false
    }
    if (this.closed || this.hostClosed) {
      sink.closed('tunnel_closed')
    } else if (this.streams.size + this.queued.size >= MAX_STREAMS) {
      sink.closed('stream_limit_exceeded')
    } else if (this.generation === null) {
      this.queued.add(state)
    } else {
      this.start(state)
    }
    return {
      write: (bytes) => {
        if (bytes.byteLength > 0 && !state.endRequested) {
          state.pending.push(bytes)
          this.flush(state)
        }
      },
      end: () => {
        state.endRequested = true
        this.flush(state)
      },
      close: () => this.closeStream(state)
    }
  }

  close(): void {
    if (this.closed) {
      return
    }
    this.closed = true
    this.unlisten()
    this.unsubscribe()
    this.endAll('tunnel_closed')
  }

  private handleEvent(event: MobileBrowserTunnelEvent): void {
    if (this.closed) {
      return
    }
    if (event.type === 'closed') {
      if (event.tunnelGeneration === this.generation) {
        this.generation = null
        this.hostClosed = true
        this.endAll('tunnel_closed')
        this.options.onClosed?.()
      }
      return
    }
    this.hostClosed = false
    if (this.generation !== null) {
      this.endAll('tunnel_restarted')
    }
    this.generation = event.tunnelGeneration
    this.nextStreamId = 1
    const queued = [...this.queued]
    this.queued.clear()
    for (const state of queued) {
      this.start(state)
    }
  }

  private start(state: StreamState): void {
    const id = this.nextStreamId++
    state.id = id
    this.streams.set(id, state)
    if (
      !this.send(BrowserNetworkTunnelOpcode.Open, id, encodeBrowserNetworkTunnelOpen(state.target))
    ) {
      this.drop(state, 'tunnel_send_failed')
    }
  }

  private handleFrame(bytes: Uint8Array): void {
    const frame = decodeBrowserNetworkTunnelFrame(bytes)
    if (!frame || frame.tunnelGeneration !== this.generation) {
      return
    }
    if (frame.opcode === BrowserNetworkTunnelOpcode.Ping) {
      this.send(BrowserNetworkTunnelOpcode.Pong, frame.streamId, frame.payload)
      return
    }
    const state = this.streams.get(frame.streamId)
    if (state) {
      this.handleStreamFrame(state, frame)
    }
  }

  private handleStreamFrame(state: StreamState, frame: BrowserNetworkTunnelFrame): void {
    switch (frame.opcode) {
      case BrowserNetworkTunnelOpcode.Opened:
        this.send(
          BrowserNetworkTunnelOpcode.WindowUpdate,
          frame.streamId,
          encodeBrowserNetworkTunnelWindowUpdate(RECEIVE_WINDOW_BYTES)
        )
        state.sink.opened()
        return
      case BrowserNetworkTunnelOpcode.WindowUpdate:
        state.sendCredit += decodeBrowserNetworkTunnelWindowUpdate(frame.payload) ?? 0
        this.flush(state)
        return
      case BrowserNetworkTunnelOpcode.Data:
        if (frame.payload.byteLength > 0) {
          state.sink.data(frame.payload)
          // The native proxy writes to a loopback socket at once, so hand the credit straight back.
          this.send(
            BrowserNetworkTunnelOpcode.WindowUpdate,
            frame.streamId,
            encodeBrowserNetworkTunnelWindowUpdate(frame.payload.byteLength)
          )
        }
        return
      case BrowserNetworkTunnelOpcode.HalfClose:
        state.sink.end()
        return
      case BrowserNetworkTunnelOpcode.Close:
        this.drop(state)
        return
      case BrowserNetworkTunnelOpcode.Error:
        this.drop(state, new TextDecoder().decode(frame.payload))
        return
      case BrowserNetworkTunnelOpcode.Open:
      case BrowserNetworkTunnelOpcode.Ping:
      case BrowserNetworkTunnelOpcode.Pong:
        // Hosts never open streams toward the phone; heartbeats are answered before stream lookup.
        return
    }
  }

  private flush(state: StreamState): void {
    if (state.id === null || !this.streams.has(state.id)) {
      return
    }
    while (state.pending.length > 0 && state.sendCredit > 0) {
      const head = state.pending[0]!
      const size = Math.min(
        head.byteLength,
        state.sendCredit,
        BROWSER_NETWORK_TUNNEL_MAX_DATA_BYTES
      )
      if (!this.send(BrowserNetworkTunnelOpcode.Data, state.id, head.subarray(0, size))) {
        this.drop(state, 'tunnel_send_failed')
        return
      }
      state.sendCredit -= size
      if (size === head.byteLength) {
        state.pending.shift()
      } else {
        state.pending[0] = head.subarray(size)
      }
    }
    if (state.endRequested && state.pending.length === 0 && !state.halfCloseSent) {
      state.halfCloseSent = true
      this.send(BrowserNetworkTunnelOpcode.HalfClose, state.id)
    }
  }

  private closeStream(state: StreamState): void {
    if (this.queued.delete(state)) {
      return
    }
    if (state.id !== null && this.streams.get(state.id) === state) {
      this.streams.delete(state.id)
      this.send(BrowserNetworkTunnelOpcode.Close, state.id)
    }
  }

  private drop(state: StreamState, reason?: string): void {
    if (state.id !== null && this.streams.get(state.id) === state) {
      this.streams.delete(state.id)
      state.sink.closed(reason)
    }
  }

  private endAll(reason: string): void {
    const states = [...this.queued, ...this.streams.values()]
    this.queued.clear()
    this.streams.clear()
    for (const state of states) {
      state.sink.closed(reason)
    }
  }

  private send(
    opcode: BrowserNetworkTunnelOpcode,
    streamId: number,
    payload?: Uint8Array
  ): boolean {
    if (this.generation === null) {
      return false
    }
    return this.options.channel.send(
      encodeBrowserNetworkTunnelFrame({
        opcode,
        tunnelGeneration: this.generation,
        streamId,
        payload: payload ?? new Uint8Array()
      })
    )
  }
}
