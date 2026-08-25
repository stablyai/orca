import {
  BrowserNetworkTunnelOpcode,
  decodeBrowserNetworkTunnelFrame,
  encodeBrowserNetworkTunnelWindowUpdate,
  type BrowserNetworkTunnelFrame
} from '../../shared/browser-network-tunnel-protocol'
import { admitBrowserNetworkTunnelOpen } from './browser-network-tunnel-open-admission'
import {
  BROWSER_NETWORK_TUNNEL_ROUTE_BUFFER_OVERFLOW,
  flushBrowserNetworkDestination,
  grantBrowserNetworkDestinationCredit,
  halfCloseBrowserNetworkDestination,
  queueBrowserNetworkDestinationData,
  writeBrowserNetworkDestination
} from './browser-network-tunnel-destination-flow'
import { BrowserNetworkTunnelFrameSender } from './browser-network-tunnel-frame-sender'
import { handleBrowserNetworkTunnelHeartbeat } from './browser-network-tunnel-heartbeat'
import { createBrowserNetworkTunnelResourceBudget } from './browser-network-tunnel-resource-budget'
import {
  BROWSER_NETWORK_TUNNEL_INITIAL_WINDOW_BYTES,
  validateBrowserNetworkTunnelGeneration,
  type BrowserNetworkTunnelSessionOptions,
  type BrowserNetworkTunnelStream
} from './browser-network-tunnel-stream-state'
import { retireBrowserNetworkTunnelStream } from './browser-network-tunnel-stream-lifecycle'

export class BrowserNetworkTunnelSession {
  private readonly tunnelGeneration: number
  private readonly connect: BrowserNetworkTunnelSessionOptions['connect']
  private readonly frameSender: BrowserNetworkTunnelFrameSender
  private readonly onClose: BrowserNetworkTunnelSessionOptions['onClose']
  private readonly resourceBudget: ReturnType<typeof createBrowserNetworkTunnelResourceBudget>
  private readonly streams = new Map<number, BrowserNetworkTunnelStream>()
  private readonly openedStreamIds = new Set<number>()
  private closed = false

  constructor(options: BrowserNetworkTunnelSessionOptions) {
    validateBrowserNetworkTunnelGeneration(options.tunnelGeneration)
    this.tunnelGeneration = options.tunnelGeneration
    this.connect = options.connect
    this.frameSender = new BrowserNetworkTunnelFrameSender(
      options.tunnelGeneration,
      options.sendBinary,
      () => this.close(),
      () => !this.closed
    )
    this.onClose = options.onClose
    this.resourceBudget = createBrowserNetworkTunnelResourceBudget(options)
  }

  handleBinary(bytes: Uint8Array<ArrayBufferLike>): void {
    if (this.closed) {
      return
    }
    const frame = decodeBrowserNetworkTunnelFrame(bytes)
    if (!frame) {
      this.close()
      return
    }
    if (frame.tunnelGeneration !== this.tunnelGeneration) {
      return
    }
    this.handleFrame(frame)
  }

  close(): void {
    if (this.closed) {
      return
    }
    this.closed = true
    for (const stream of this.streams.values()) {
      this.retireStream(stream)
    }
    this.streams.clear()
    this.onClose?.()
  }

  private handleFrame(frame: BrowserNetworkTunnelFrame): void {
    if (handleBrowserNetworkTunnelHeartbeat(frame, this.frameSender)) {
      return
    }
    if (frame.opcode === BrowserNetworkTunnelOpcode.Open) {
      this.openStream(frame)
      return
    }
    const stream = this.streams.get(frame.streamId)
    if (!stream) {
      if (this.openedStreamIds.has(frame.streamId)) {
        return
      }
      this.close()
      return
    }
    if (frame.opcode === BrowserNetworkTunnelOpcode.Data) {
      this.writeToDestination(stream, frame.payload)
    } else if (frame.opcode === BrowserNetworkTunnelOpcode.WindowUpdate) {
      this.grantDestinationCredit(stream, frame.payload)
    } else if (frame.opcode === BrowserNetworkTunnelOpcode.HalfClose) {
      const error = halfCloseBrowserNetworkDestination(stream)
      if (error) {
        this.failProtocolStream(stream, error)
      }
    } else if (
      frame.opcode === BrowserNetworkTunnelOpcode.Close ||
      frame.opcode === BrowserNetworkTunnelOpcode.Error
    ) {
      this.deleteStream(stream)
    } else {
      this.failProtocolStream(stream, 'invalid_stream_transition')
    }
  }

  private openStream(frame: BrowserNetworkTunnelFrame): void {
    const stream = admitBrowserNetworkTunnelOpen(frame, {
      openedStreamIds: this.openedStreamIds,
      streamCount: this.streams.size,
      resourceBudget: this.resourceBudget,
      connect: this.connect,
      sendError: (streamId, code) => this.frameSender.sendError(streamId, code),
      closeSession: () => this.close(),
      onConnectTimeout: (pendingStream) =>
        this.failStream(pendingStream, 'destination_connect_timeout')
    })
    if (!stream) {
      return
    }
    const socket = stream.socket
    this.streams.set(stream.id, stream)
    socket.setNoDelay(true)
    socket.pause()
    socket.on('connect', () => this.onDestinationConnected(stream))
    socket.on('data', (data) => this.onDestinationData(stream, data))
    socket.on('end', () => this.onDestinationEnd(stream))
    socket.on('close', () => this.onDestinationClose(stream))
    socket.on('error', () => this.failStream(stream, 'destination_error'))
  }

  private onDestinationConnected(stream: BrowserNetworkTunnelStream): void {
    if (!this.isCurrent(stream) || stream.connected) {
      return
    }
    stream.connected = true
    stream.releasePendingOpen()
    clearTimeout(stream.connectTimeout)
    this.frameSender.send(BrowserNetworkTunnelOpcode.Opened, stream.id)
    this.frameSender.send(
      BrowserNetworkTunnelOpcode.WindowUpdate,
      stream.id,
      encodeBrowserNetworkTunnelWindowUpdate(BROWSER_NETWORK_TUNNEL_INITIAL_WINDOW_BYTES)
    )
  }

  private writeToDestination(
    stream: BrowserNetworkTunnelStream,
    payload: Uint8Array<ArrayBufferLike>
  ): void {
    const error = writeBrowserNetworkDestination(
      stream,
      payload,
      (bytes) => {
        if (!this.isCurrent(stream)) {
          return
        }
        stream.receiveCredit += bytes
        this.frameSender.send(
          BrowserNetworkTunnelOpcode.WindowUpdate,
          stream.id,
          encodeBrowserNetworkTunnelWindowUpdate(bytes)
        )
      },
      (bytes) => this.resourceBudget.claimRetainedBytes(bytes)
    )
    if (error) {
      this.failDestinationFlow(stream, error)
    }
  }

  // The host grants more credit than the retained pool can hold (128 streams x 256 KB vs 8 MB),
  // so a budget miss is reachable by a fully conforming peer and must not fence the tunnel.
  private failDestinationFlow(stream: BrowserNetworkTunnelStream, code: string): void {
    if (code === BROWSER_NETWORK_TUNNEL_ROUTE_BUFFER_OVERFLOW) {
      this.failStream(stream, code)
      return
    }
    this.failProtocolStream(stream, code)
  }

  private grantDestinationCredit(
    stream: BrowserNetworkTunnelStream,
    payload: Uint8Array<ArrayBufferLike>
  ): void {
    const error = grantBrowserNetworkDestinationCredit(stream, payload)
    if (error) {
      this.failProtocolStream(stream, error)
      return
    }
    this.flushDestinationData(stream)
  }

  private onDestinationData(
    stream: BrowserNetworkTunnelStream,
    bytes: Uint8Array<ArrayBufferLike>
  ): void {
    if (!this.isCurrent(stream) || bytes.byteLength === 0) {
      return
    }
    if (!this.resourceBudget.reserveRetainedBytes(bytes.byteLength)) {
      this.failStream(stream, BROWSER_NETWORK_TUNNEL_ROUTE_BUFFER_OVERFLOW)
      return
    }
    const error = queueBrowserNetworkDestinationData(stream, bytes)
    if (error) {
      this.resourceBudget.releaseRetainedBytes(bytes.byteLength)
      this.failStream(stream, error)
      return
    }
    this.flushDestinationData(stream)
  }

  private flushDestinationData(stream: BrowserNetworkTunnelStream): void {
    flushBrowserNetworkDestination(stream, {
      isCurrent: () => this.isCurrent(stream),
      sendData: (bytes) => this.frameSender.send(BrowserNetworkTunnelOpcode.Data, stream.id, bytes),
      sendHalfClose: () => this.sendDestinationHalfClose(stream),
      finalizeClose: () => this.finalizeDestinationClose(stream),
      releaseRetainedBytes: (bytes) => this.resourceBudget.releaseRetainedBytes(bytes)
    })
  }

  private onDestinationEnd(stream: BrowserNetworkTunnelStream): void {
    if (!this.isCurrent(stream)) {
      return
    }
    if (!stream.connected) {
      this.failStream(stream, 'destination_closed_before_connect')
      return
    }
    if (stream.destinationEnded) {
      this.failStream(stream, 'duplicate_destination_half_close')
      return
    }
    stream.destinationEnded = true
    if (stream.pendingToClient.length === 0) {
      this.sendDestinationHalfClose(stream)
    }
  }

  private onDestinationClose(stream: BrowserNetworkTunnelStream): void {
    if (!this.isCurrent(stream)) {
      return
    }
    // The client has never seen Opened for this stream, so HalfClose/Close would read as a
    // protocol violation and fence the whole tunnel; fail just this stream instead.
    if (!stream.connected) {
      this.failStream(stream, 'destination_closed_before_connect')
      return
    }
    stream.destinationClosed = true
    if (stream.pendingToClient.length === 0) {
      this.finalizeDestinationClose(stream)
    }
  }

  private failStream(stream: BrowserNetworkTunnelStream, code: string): void {
    if (!this.isCurrent(stream)) {
      return
    }
    this.frameSender.sendError(stream.id, code)
    this.deleteStream(stream)
  }

  private failProtocolStream(stream: BrowserNetworkTunnelStream, code: string): void {
    if (!this.isCurrent(stream)) {
      return
    }
    this.frameSender.sendError(stream.id, code)
    this.close()
  }

  private sendDestinationHalfClose(stream: BrowserNetworkTunnelStream): void {
    if (stream.destinationHalfCloseSent) {
      return
    }
    stream.destinationHalfCloseSent = true
    this.frameSender.send(BrowserNetworkTunnelOpcode.HalfClose, stream.id)
  }

  private finalizeDestinationClose(stream: BrowserNetworkTunnelStream): void {
    this.frameSender.send(BrowserNetworkTunnelOpcode.Close, stream.id)
    this.deleteStream(stream)
  }

  private deleteStream(stream: BrowserNetworkTunnelStream): void {
    if (!this.isCurrent(stream)) {
      return
    }
    this.streams.delete(stream.id)
    this.retireStream(stream)
  }

  private retireStream(stream: BrowserNetworkTunnelStream): void {
    retireBrowserNetworkTunnelStream(stream, (bytes) =>
      this.resourceBudget.releaseRetainedBytes(bytes)
    )
  }

  private isCurrent(stream: BrowserNetworkTunnelStream): boolean {
    return !this.closed && !stream.closed && this.streams.get(stream.id) === stream
  }
}
