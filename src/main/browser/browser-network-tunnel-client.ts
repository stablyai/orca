import {
  BrowserNetworkTunnelOpcode,
  decodeBrowserNetworkTunnelFrame,
  encodeBrowserNetworkTunnelOpen,
  encodeBrowserNetworkTunnelWindowUpdate,
  type BrowserNetworkTunnelFrame,
  type BrowserNetworkTunnelOpen
} from '../../shared/browser-network-tunnel-protocol'
import { BrowserNetworkTunnelFrameSender } from './browser-network-tunnel-frame-sender'
import { handleBrowserNetworkTunnelHeartbeat } from './browser-network-tunnel-heartbeat'
import type { BrowserNetworkTunnelOutboundMemoryLease } from './browser-network-tunnel-outbound-memory-budget'
import {
  BROWSER_NETWORK_TUNNEL_INITIAL_WINDOW_BYTES,
  BROWSER_NETWORK_TUNNEL_MAX_STREAM_IDS,
  validateBrowserNetworkTunnelGeneration
} from './browser-network-tunnel-stream-state'
import {
  flushBrowserNetworkSourceWrites,
  queueBrowserNetworkSourceWrite
} from './browser-network-tunnel-source-flow'
import {
  createBrowserNetworkTunnelClientStream,
  type BrowserNetworkTunnelClientStream
} from './browser-network-tunnel-client-stream'
import type { BrowserNetworkTunnelDuplex } from './browser-network-tunnel-duplex'
import {
  beginBrowserNetworkSourceRead,
  grantBrowserNetworkSourceReceiveCredit,
  settleBrowserNetworkSourceData
} from './browser-network-tunnel-source-receive-flow'
import { retireBrowserNetworkTunnelClientStream } from './browser-network-tunnel-client-retirement'
import { handleBrowserNetworkTunnelClientStreamFrame } from './browser-network-tunnel-client-stream-frames'

type BrowserNetworkTunnelClientOptions = {
  tunnelGeneration: number
  sendBinary: (bytes: Uint8Array<ArrayBufferLike>) => boolean
  outboundMemory?: Pick<BrowserNetworkTunnelOutboundMemoryLease, 'claimApplicationBytes'>
  maxStreamIds?: number
  onClosed?: (error: Error) => void
}

export class BrowserNetworkTunnelClient {
  private readonly tunnelGeneration: number
  private readonly frameSender: BrowserNetworkTunnelFrameSender
  private readonly outboundMemory: BrowserNetworkTunnelClientOptions['outboundMemory']
  private readonly maxStreamIds: number
  private readonly onClosed: BrowserNetworkTunnelClientOptions['onClosed']
  private readonly streams = new Map<number, BrowserNetworkTunnelClientStream>()
  private nextStreamId = 1
  private closed = false

  constructor(options: BrowserNetworkTunnelClientOptions) {
    validateBrowserNetworkTunnelGeneration(options.tunnelGeneration)
    this.tunnelGeneration = options.tunnelGeneration
    this.outboundMemory = options.outboundMemory
    this.onClosed = options.onClosed
    this.maxStreamIds = options.maxStreamIds ?? BROWSER_NETWORK_TUNNEL_MAX_STREAM_IDS
    if (
      !Number.isSafeInteger(this.maxStreamIds) ||
      this.maxStreamIds < 1 ||
      this.maxStreamIds > BROWSER_NETWORK_TUNNEL_MAX_STREAM_IDS
    ) {
      throw new Error('Browser tunnel stream id budget is invalid')
    }
    this.frameSender = new BrowserNetworkTunnelFrameSender(
      options.tunnelGeneration,
      options.sendBinary,
      () => this.close(new Error('Browser tunnel transport rejected a frame')),
      () => !this.closed
    )
  }

  get generation(): number {
    return this.tunnelGeneration
  }

  get streamIdsExhausted(): boolean {
    return this.nextStreamId > this.maxStreamIds
  }

  open(target: BrowserNetworkTunnelOpen): Promise<BrowserNetworkTunnelDuplex> {
    if (this.closed) {
      return Promise.reject(new Error('Browser tunnel is closed'))
    }
    if (this.streams.size >= 32) {
      return Promise.reject(new Error('Browser tunnel stream limit exceeded'))
    }
    if (this.streamIdsExhausted) {
      return Promise.reject(new Error('Browser tunnel stream id limit exceeded'))
    }
    let openPayload: Uint8Array<ArrayBufferLike>
    try {
      openPayload = encodeBrowserNetworkTunnelOpen(target)
    } catch (error) {
      return Promise.reject(error)
    }
    const id = this.nextStreamId++
    const { stream, opening } = createBrowserNetworkTunnelClientStream(id, {
      writeBytes: (bytes, callback) => this.writeStream(id, bytes, callback),
      requestRead: () => this.readStream(id),
      consumeReadBytes: (bytes) => this.consumeStreamBytes(id, bytes),
      finishWrite: (callback) => this.endStream(id, callback),
      destroyStream: (error, callback) => this.destroyStream(id, error, callback),
      onConnectTimeout: (timedOutStream) =>
        this.failStream(timedOutStream, new Error('Browser tunnel destination connect timed out'))
    })
    this.streams.set(id, stream)
    if (!this.frameSender.send(BrowserNetworkTunnelOpcode.Open, id, openPayload)) {
      this.close(new Error('Browser tunnel transport rejected an open frame'))
    }
    return opening
  }

  handleBinary(bytes: Uint8Array<ArrayBufferLike>): void {
    if (this.closed) {
      return
    }
    const frame = decodeBrowserNetworkTunnelFrame(bytes)
    if (!frame) {
      this.close(new Error('Browser tunnel received an invalid frame'))
      return
    }
    if (frame.tunnelGeneration !== this.tunnelGeneration) {
      return
    }
    if (handleBrowserNetworkTunnelHeartbeat(frame, this.frameSender)) {
      return
    }
    const stream = this.streams.get(frame.streamId)
    if (!stream) {
      if (frame.streamId < this.nextStreamId) {
        return
      }
      this.close(new Error('Browser tunnel received a frame for an unknown stream'))
      return
    }
    this.handleStreamFrame(stream, frame)
  }

  close(error = new Error('Browser tunnel is closed')): void {
    if (this.closed) {
      return
    }
    this.closed = true
    for (const stream of Array.from(this.streams.values())) {
      this.retireStream(stream, error)
    }
    this.streams.clear()
    this.onClosed?.(error)
  }

  private handleStreamFrame(
    stream: BrowserNetworkTunnelClientStream,
    frame: BrowserNetworkTunnelFrame
  ): void {
    handleBrowserNetworkTunnelClientStreamFrame(stream, frame, {
      send: (opcode, streamId, payload) => this.frameSender.send(opcode, streamId, payload),
      closeTunnel: (error) => this.close(error),
      flushWrites: (target) => this.flushStreamWrites(target),
      claimApplicationBytes: (bytes) => this.claimApplicationBytes(bytes),
      retire: (target, error) => this.retireStream(target, error)
    })
  }

  private writeStream(
    streamId: number,
    bytes: Uint8Array<ArrayBufferLike>,
    callback: (error?: Error | null) => void
  ): void {
    const stream = this.streams.get(streamId)
    if (!stream || !stream.opened || stream.localEnded) {
      callback(new Error('Browser tunnel stream is not writable'))
      return
    }
    if (
      !queueBrowserNetworkSourceWrite(stream, bytes, callback, (pendingBytes) =>
        this.claimApplicationBytes(pendingBytes)
      )
    ) {
      const error = new Error('Browser tunnel source buffer overflow')
      callback(error)
      this.failStream(stream, error)
      return
    }
    this.flushStreamWrites(stream)
  }

  private flushStreamWrites(stream: BrowserNetworkTunnelClientStream): void {
    const flushed = flushBrowserNetworkSourceWrites(
      stream,
      (payload) =>
        this.isCurrent(stream) &&
        this.frameSender.send(BrowserNetworkTunnelOpcode.Data, stream.id, payload)
    )
    if (!flushed) {
      this.close(new Error('Browser tunnel transport rejected data'))
      return
    }
    if (
      this.isCurrent(stream) &&
      stream.localEnded &&
      !stream.localHalfCloseSent &&
      stream.pendingWrites.length === 0
    ) {
      stream.localHalfCloseSent = true
      if (!this.frameSender.send(BrowserNetworkTunnelOpcode.HalfClose, stream.id)) {
        this.close(new Error('Browser tunnel transport rejected a half-close'))
      }
    }
  }

  private readStream(streamId: number): void {
    const stream = this.streams.get(streamId)
    if (!stream) {
      return
    }
    beginBrowserNetworkSourceRead(stream)
  }

  private consumeStreamBytes(streamId: number, bytes: number): void {
    const stream = this.streams.get(streamId)
    if (stream && settleBrowserNetworkSourceData(stream, bytes)) {
      this.replenishStreamCredit(stream, bytes)
    } else if (stream) {
      this.close(new Error('Browser tunnel settled invalid destination bytes'))
    }
  }

  private replenishStreamCredit(stream: BrowserNetworkTunnelClientStream, bytes: number): void {
    if (!this.isCurrent(stream) || stream.remoteClosed || bytes === 0) {
      return
    }
    if (
      !grantBrowserNetworkSourceReceiveCredit(
        stream,
        bytes,
        BROWSER_NETWORK_TUNNEL_INITIAL_WINDOW_BYTES
      )
    ) {
      this.close(new Error('Browser tunnel receive credit overflow'))
      return
    }
    if (
      !this.frameSender.send(
        BrowserNetworkTunnelOpcode.WindowUpdate,
        stream.id,
        encodeBrowserNetworkTunnelWindowUpdate(bytes)
      )
    ) {
      this.close(new Error('Browser tunnel transport rejected receive credit'))
    }
  }

  private endStream(streamId: number, callback: (error?: Error | null) => void): void {
    const stream = this.streams.get(streamId)
    if (!stream || stream.localEnded) {
      callback()
      return
    }
    stream.localEnded = true
    this.flushStreamWrites(stream)
    callback()
  }

  private destroyStream(
    streamId: number,
    error: Error | null,
    callback: (error?: Error | null) => void
  ): void {
    const stream = this.streams.get(streamId)
    if (stream && this.isCurrent(stream)) {
      this.frameSender.send(BrowserNetworkTunnelOpcode.Close, stream.id)
      this.retireStream(stream, error ?? undefined, false)
    }
    callback(error)
  }

  private failStream(stream: BrowserNetworkTunnelClientStream, error: Error): void {
    if (!this.isCurrent(stream)) {
      return
    }
    this.frameSender.send(
      BrowserNetworkTunnelOpcode.Error,
      stream.id,
      new TextEncoder().encode(error.message)
    )
    this.retireStream(stream, error)
  }

  private retireStream(
    stream: BrowserNetworkTunnelClientStream,
    error?: Error,
    destroySocket = true
  ): void {
    retireBrowserNetworkTunnelClientStream(stream, {
      error,
      destroySocket,
      remove: () => this.streams.delete(stream.id)
    })
  }

  private isCurrent(stream: BrowserNetworkTunnelClientStream): boolean {
    return !this.closed && !stream.closed && this.streams.get(stream.id) === stream
  }

  private claimApplicationBytes(bytes: number): (() => void) | null {
    if (!this.outboundMemory) {
      return () => undefined
    }
    return this.outboundMemory.claimApplicationBytes(bytes)
  }
}
