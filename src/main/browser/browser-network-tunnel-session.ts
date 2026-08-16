import {
  BrowserNetworkTunnelOpcode,
  decodeBrowserNetworkTunnelFrame,
  decodeBrowserNetworkTunnelOpen,
  encodeBrowserNetworkTunnelWindowUpdate,
  type BrowserNetworkTunnelFrame
} from '../../shared/browser-network-tunnel-protocol'
import {
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
  reserveBrowserNetworkTunnelStreamId,
  validateBrowserNetworkTunnelGeneration,
  type BrowserNetworkTunnelSessionOptions,
  type BrowserNetworkTunnelSocket,
  type BrowserNetworkTunnelStream
} from './browser-network-tunnel-stream-state'
import {
  createBrowserNetworkTunnelStream,
  retireBrowserNetworkTunnelStream
} from './browser-network-tunnel-stream-lifecycle'

const BROWSER_NETWORK_TUNNEL_MAX_STREAMS = 128

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
    const identityError = reserveBrowserNetworkTunnelStreamId(this.openedStreamIds, frame.streamId)
    if (identityError) {
      this.frameSender.sendError(frame.streamId, identityError)
      this.close()
      return
    }
    if (!this.resourceBudget.admitOpenAttempt()) {
      this.frameSender.sendError(frame.streamId, 'open_rate_exceeded')
      return
    }
    if (this.streams.size >= BROWSER_NETWORK_TUNNEL_MAX_STREAMS) {
      this.frameSender.sendError(frame.streamId, 'stream_limit_exceeded')
      return
    }
    const target = decodeBrowserNetworkTunnelOpen(frame.payload)
    if (!target) {
      this.frameSender.sendError(frame.streamId, 'invalid_open_target')
      return
    }
    const releasePendingOpen = this.resourceBudget.claimPendingOpen()
    if (!releasePendingOpen) {
      this.frameSender.sendError(frame.streamId, 'pending_open_limit_exceeded')
      return
    }
    let socket: BrowserNetworkTunnelSocket
    try {
      socket = this.connect(target)
    } catch {
      releasePendingOpen()
      this.frameSender.sendError(frame.streamId, 'destination_connect_failed')
      return
    }
    const stream = createBrowserNetworkTunnelStream({
      id: frame.streamId,
      socket,
      releasePendingOpen,
      onConnectTimeout: (pendingStream) =>
        this.failStream(pendingStream, 'destination_connect_timeout')
    })
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
      this.failProtocolStream(stream, error)
    }
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
      this.failProtocolStream(stream, 'route_buffer_overflow')
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
