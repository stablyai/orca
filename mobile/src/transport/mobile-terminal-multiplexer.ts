import { TerminalSubscribe } from '../../../src/shared/rpc-contract/terminal-stream-params'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson,
  readTerminalStreamFrameId
} from '../../../src/shared/terminal-stream-protocol'
import {
  TERMINAL_MULTIPLEX_MAX_ACTIVE_STREAMS_PER_CONNECTION,
  TERMINAL_MULTIPLEX_STREAM_LIMIT_ERROR
} from '../../../src/shared/terminal-multiplex-flow-control'
import {
  REMOTE_RUNTIME_MAX_PENDING_RPC_BYTES,
  REMOTE_RUNTIME_MAX_PENDING_REQUESTS
} from '../../../src/shared/remote-runtime/remote-runtime-memory-limits'
import { RpcClientTerminalStreamRouter } from './rpc-client-terminal-stream-router'
import { createMobileTerminalEventApplication } from './mobile-terminal-event-application'
import type { RpcClient } from './rpc-client'
import type { RpcEnvelopeFields } from './rpc-envelope-fields'

import { isTerminalStreamEvent, type Listener, type Stream } from './mobile-terminal-stream-record'

// One physical connection owns the host's aggregate credit window and the phone's application budget.
export class MobileTerminalMultiplexer {
  private readonly streams = new Map<number, Stream>()
  private readonly router = new RpcClientTerminalStreamRouter()
  private nextStreamId = 1
  private supported: boolean | null = null
  private stop: (() => void) | null = null
  private retainedBytes = 0
  private retainedFrames = 0

  private readonly apply = createMobileTerminalEventApplication({
    isCurrent: (id, stream) => this.streams.get(id) === stream,
    release: (stream, bytes, frames) => this.release(stream, bytes, frames),
    acknowledge: (id, bytes) => this.send(id, TerminalStreamOpcode.Ack, { bytes }),
    fail: (id, message) => this.fail(id, message)
  })

  constructor(
    private readonly options: {
      subscribe: RpcClient['subscribe']
      sendBinary: (bytes: Uint8Array) => boolean
    }
  ) {}

  subscribe(
    method: string,
    params: unknown,
    listener: Listener,
    envelope?: RpcEnvelopeFields
  ): (() => void) | null {
    const parsed =
      method === 'terminal.subscribe' && !envelope ? TerminalSubscribe.safeParse(params) : null
    if (
      !parsed?.success ||
      parsed.data.capabilities?.ackOutput !== 1 ||
      parsed.data.capabilities.mobileInputLeaseOnly === 1
    ) {
      return null
    }
    if (this.streams.size >= TERMINAL_MULTIPLEX_MAX_ACTIVE_STREAMS_PER_CONNECTION) {
      listener({ type: 'error', message: TERMINAL_MULTIPLEX_STREAM_LIMIT_ERROR })
      return () => {}
    }
    const id = this.nextStreamId++
    const stream: Stream = {
      params: parsed.data,
      listener,
      subscribed: false,
      bytes: 0,
      frames: 0,
      snapshotBytes: 0,
      snapshotFrames: 0
    }
    this.streams.set(id, stream)
    if (this.supported !== null) {
      this.startStream(id, stream)
    } else if (!this.stop) {
      this.stop = this.options.subscribe('terminal.multiplex', {}, (result) => {
        const event = result
        if (!isTerminalStreamEvent(event)) {
          return
        }
        if (event.type === 'ready') {
          const caps = event.capabilities
          this.supported =
            typeof caps === 'object' &&
            caps !== null &&
            'mobileTerminalOutputCredits' in caps &&
            caps.mobileTerminalOutputCredits === 1
          for (const [streamId, pending] of this.streams) {
            this.startStream(streamId, pending)
          }
        } else if (
          (event.type === 'error' || event.type === 'end') &&
          typeof event.streamId !== 'number'
        ) {
          if (this.supported === true) {
            this.reset()
            return
          }
          // Old hosts may not expose multiplex at all; preserve their subscribe protocol.
          this.supported = false
          for (const [streamId, pending] of this.streams) {
            this.startStream(streamId, pending)
          }
        } else if (typeof event.streamId === 'number') {
          const pending = this.streams.get(event.streamId)
          pending?.listener(result)
          if (event.type === 'end' || event.type === 'error') {
            this.remove(event.streamId)
          }
        }
      })
    }
    return () => this.remove(id)
  }

  handleBinary(bytes: Uint8Array): boolean {
    const frame = decodeTerminalStreamFrame(bytes)
    const streamId = frame?.streamId ?? readTerminalStreamFrameId(bytes) ?? undefined
    const stream = streamId === undefined ? undefined : this.streams.get(streamId)
    if (!stream || !stream.subscribed || streamId === undefined) {
      return false
    }
    if (!frame) {
      this.fail(streamId, 'Unreadable terminal output')
      return true
    }
    const retained = bytes.byteLength * 2
    const snapshot =
      frame.opcode === TerminalStreamOpcode.SnapshotStart ||
      frame.opcode === TerminalStreamOpcode.SnapshotChunk ||
      frame.opcode === TerminalStreamOpcode.SnapshotEnd
    const frames = snapshot && frame.opcode !== TerminalStreamOpcode.SnapshotStart ? 0 : 1
    if (
      this.retainedBytes + retained > REMOTE_RUNTIME_MAX_PENDING_RPC_BYTES ||
      this.retainedFrames + frames > REMOTE_RUNTIME_MAX_PENDING_REQUESTS
    ) {
      this.fail(streamId, 'Terminal application buffer overflow')
      return true
    }
    this.retainedBytes += retained
    this.retainedFrames += frames
    stream.bytes += retained
    stream.frames += frames
    if (snapshot) {
      stream.snapshotBytes += retained
      stream.snapshotFrames += frames
    }
    const outputBytes =
      frame.opcode === TerminalStreamOpcode.Output ||
      frame.opcode === TerminalStreamOpcode.OutputSpan
        ? frame.payload.byteLength
        : 0
    let delivered = false
    this.router.register(String(streamId), streamId, (event) => {
      delivered = true
      if (isTerminalStreamEvent(event) && event.type === 'error') {
        this.fail(streamId, 'Unreadable terminal output')
        return
      }
      const cost = snapshot ? stream.snapshotBytes : retained
      const count = snapshot ? stream.snapshotFrames : 1
      if (snapshot) {
        stream.snapshotBytes = 0
        stream.snapshotFrames = 0
      }
      this.apply(streamId, stream, event, {
        bytes: cost,
        frames: count,
        outputBytes,
        receipt: snapshot || outputBytes > 0
      })
    })
    this.router.handle(bytes)
    if (!delivered && !snapshot) {
      this.release(stream, retained, 1)
    }
    return true
  }

  reset(): void {
    const streams = Array.from(this.streams.entries())
    for (const [id] of streams) {
      this.remove(id)
    }
    this.stop?.()
    this.stop = null
    this.supported = null
    for (const [, stream] of streams) {
      stream.listener({ type: 'end' })
    }
  }

  private startStream(id: number, stream: Stream): void {
    if (stream.subscribed || stream.stopLegacy || this.streams.get(id) !== stream) {
      return
    }
    if (!this.supported) {
      const stopLegacy = this.options.subscribe('terminal.subscribe', stream.params, (event) => {
        const data = event
        if (!isTerminalStreamEvent(data)) {
          return
        }
        if (data.type === 'end' || data.type === 'error') {
          this.remove(id)
          return stream.listener(event)
        }
        const text =
          typeof data.chunk === 'string'
            ? data.chunk
            : typeof data.serialized === 'string'
              ? data.serialized
              : ''
        const bytes = text.length * 2
        if (
          this.retainedBytes + bytes > REMOTE_RUNTIME_MAX_PENDING_RPC_BYTES ||
          this.retainedFrames >= REMOTE_RUNTIME_MAX_PENDING_REQUESTS
        ) {
          this.fail(id, 'Terminal application buffer overflow')
          return
        }
        this.retainedBytes += bytes
        this.retainedFrames++
        stream.bytes += bytes
        stream.frames++
        return this.apply(id, stream, event, {
          bytes,
          frames: 1,
          receipt:
            data.type === 'data' ||
            data.type === 'scrollback' ||
            typeof data.serialized === 'string'
        })
      })
      if (this.streams.get(id) === stream) {
        stream.stopLegacy = stopLegacy
      } else {
        stopLegacy()
      }
      return
    }
    stream.subscribed = true
    if (
      !this.send(0, TerminalStreamOpcode.Subscribe, {
        ...stream.params,
        streamId: id,
        capabilities: { ackOutput: 1 }
      })
    ) {
      this.fail(id, 'Terminal subscription failed')
    }
  }

  updateTerminalViewport(terminal: string, viewport: { cols: number; rows: number }): void {
    for (const stream of this.streams.values()) {
      if (stream.params.terminal === terminal) {
        stream.params = { ...stream.params, viewport }
      }
    }
  }

  private send(streamId: number, opcode: TerminalStreamOpcode, value?: unknown): boolean {
    try {
      return this.options.sendBinary(
        encodeTerminalStreamFrame({
          streamId,
          opcode,
          seq: 0,
          payload: value === undefined ? new Uint8Array() : encodeTerminalStreamJson(value)
        })
      )
    } catch {
      return false
    }
  }

  private release(stream: Stream, bytes: number, frames: number): void {
    stream.bytes -= bytes
    stream.frames -= frames
    this.retainedBytes -= bytes
    this.retainedFrames -= frames
  }

  private remove(id: number): void {
    const stream = this.streams.get(id)
    if (!stream) {
      return
    }
    this.streams.delete(id)
    this.router.reset(String(id))
    this.release(stream, stream.bytes, stream.frames)
    stream.stopLegacy?.()
    if (stream.subscribed) {
      this.send(id, TerminalStreamOpcode.Unsubscribe)
    }
  }

  private fail(id: number, message: string): void {
    const stream = this.streams.get(id)
    this.remove(id)
    stream?.listener({ type: 'error', message })
  }
}
