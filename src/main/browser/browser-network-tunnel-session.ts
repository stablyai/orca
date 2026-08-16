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
  queueBrowserNetworkDestinationData,
  writeBrowserNetworkDestination
} from './browser-network-tunnel-destination-flow'
import { BrowserNetworkTunnelFrameSender } from './browser-network-tunnel-frame-sender'
import {
  BROWSER_NETWORK_TUNNEL_CONNECT_TIMEOUT_MS,
  BROWSER_NETWORK_TUNNEL_INITIAL_WINDOW_BYTES,
  reserveBrowserNetworkTunnelStreamId,
  validateBrowserNetworkTunnelGeneration,
  type BrowserNetworkTunnelSessionOptions,
  type BrowserNetworkTunnelSocket,
  type BrowserNetworkTunnelStream
} from './browser-network-tunnel-stream-state'

const BROWSER_NETWORK_TUNNEL_MAX_STREAMS = 128

export class BrowserNetworkTunnelSession {
  private readonly tunnelGeneration: number
  private readonly connect: BrowserNetworkTunnelSessionOptions['connect']
  private readonly frameSender: BrowserNetworkTunnelFrameSender
  private readonly onClose: BrowserNetworkTunnelSessionOptions['onClose']
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
    if (frame.opcode === BrowserNetworkTunnelOpcode.Ping) {
      this.frameSender.send(BrowserNetworkTunnelOpcode.Pong, frame.streamId, frame.payload)
      return
    }
    if (frame.opcode === BrowserNetworkTunnelOpcode.Pong) {
      return
    }
    if (frame.opcode === BrowserNetworkTunnelOpcode.Open) {
      this.openStream(frame)
      return
    }
    const stream = this.streams.get(frame.streamId)
    if (!stream) {
      this.close()
      return
    }
    if (frame.opcode === BrowserNetworkTunnelOpcode.Data) {
      this.writeToDestination(stream, frame.payload)
    } else if (frame.opcode === BrowserNetworkTunnelOpcode.WindowUpdate) {
      this.grantDestinationCredit(stream, frame.payload)
    } else if (frame.opcode === BrowserNetworkTunnelOpcode.HalfClose) {
      this.halfCloseDestination(stream)
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
      this.sendError(frame.streamId, identityError)
      this.close()
      return
    }
    if (this.streams.size >= BROWSER_NETWORK_TUNNEL_MAX_STREAMS) {
      this.sendError(frame.streamId, 'stream_limit_exceeded')
      return
    }
    const target = decodeBrowserNetworkTunnelOpen(frame.payload)
    if (!target) {
      this.sendError(frame.streamId, 'invalid_open_target')
      return
    }
    let socket: BrowserNetworkTunnelSocket
    try {
      socket = this.connect(target)
    } catch {
      this.sendError(frame.streamId, 'destination_connect_failed')
      return
    }
    const stream: BrowserNetworkTunnelStream = {
      id: frame.streamId,
      socket,
      connected: false,
      closed: false,
      receiveCredit: BROWSER_NETWORK_TUNNEL_INITIAL_WINDOW_BYTES,
      sendCredit: 0,
      pendingToClient: [],
      pendingToClientBytes: 0,
      clientEnded: false,
      destinationEnded: false,
      destinationClosed: false,
      destinationHalfCloseSent: false,
      connectTimeout: setTimeout(
        () => this.failStream(stream, 'destination_connect_timeout'),
        BROWSER_NETWORK_TUNNEL_CONNECT_TIMEOUT_MS
      )
    }
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
    const error = writeBrowserNetworkDestination(stream, payload, (bytes) => {
      if (!this.isCurrent(stream)) {
        return
      }
      stream.receiveCredit += bytes
      this.frameSender.send(
        BrowserNetworkTunnelOpcode.WindowUpdate,
        stream.id,
        encodeBrowserNetworkTunnelWindowUpdate(bytes)
      )
    })
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
    const error = queueBrowserNetworkDestinationData(stream, bytes)
    if (error) {
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
      finalizeClose: () => this.finalizeDestinationClose(stream)
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
    this.sendError(stream.id, code)
    this.deleteStream(stream)
  }

  private failProtocolStream(stream: BrowserNetworkTunnelStream, code: string): void {
    if (!this.isCurrent(stream)) {
      return
    }
    this.sendError(stream.id, code)
    this.close()
  }

  private sendError(streamId: number, code: string): void {
    this.frameSender.send(
      BrowserNetworkTunnelOpcode.Error,
      streamId,
      new TextEncoder().encode(code)
    )
  }

  private halfCloseDestination(stream: BrowserNetworkTunnelStream): void {
    if (!stream.connected || stream.clientEnded) {
      this.failProtocolStream(stream, 'invalid_client_half_close')
      return
    }
    stream.clientEnded = true
    stream.socket.end()
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
    if (stream.closed) {
      return
    }
    stream.closed = true
    clearTimeout(stream.connectTimeout)
    stream.pendingToClient = []
    stream.pendingToClientBytes = 0
    stream.socket.destroy()
  }

  private isCurrent(stream: BrowserNetworkTunnelStream): boolean {
    return !this.closed && !stream.closed && this.streams.get(stream.id) === stream
  }
}
