import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamJson,
  decodeTerminalStreamText
} from './terminal-stream-protocol'

export type TerminalSnapshotState = {
  streamId: number
  meta: Record<string, unknown>
  chunks: string[]
  bytes: number
}

export const MOBILE_TERMINAL_STREAM_FRAME_MAX_PAYLOAD_BYTES = 256 * 1024
export const MOBILE_TERMINAL_SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024
export const MOBILE_TERMINAL_SNAPSHOT_MAX_AGGREGATE_BYTES = 16 * 1024 * 1024
export const MOBILE_TERMINAL_SNAPSHOT_MAX_ACTIVE = 16
export const MOBILE_TERMINAL_SNAPSHOT_MAX_CHUNKS = 1_024

type StreamingListener = (result: unknown) => void

type TerminalBinaryFrameOptions = {
  terminalSnapshots: Map<number, TerminalSnapshotState>
  getListener: (streamId: number) => StreamingListener | undefined
  recordValidatedInboundTraffic: () => void
  maxFramePayloadBytes?: number
  maxSnapshotBytes?: number
  maxSnapshotAggregateBytes?: number
  maxActiveSnapshots?: number
  maxSnapshotChunks?: number
}

function retainedSnapshotBytes(snapshots: Map<number, TerminalSnapshotState>): number {
  let bytes = 0
  for (const snapshot of snapshots.values()) {
    bytes += snapshot.bytes
  }
  return bytes
}

function rejectSnapshot(
  options: TerminalBinaryFrameOptions,
  listener: StreamingListener,
  streamId: number,
  message: string
): void {
  options.terminalSnapshots.delete(streamId)
  listener({ type: 'error', streamId, message })
}

export function handleTerminalBinaryFrame(
  bytes: Uint8Array,
  options: TerminalBinaryFrameOptions
): void {
  const frame = decodeTerminalStreamFrame(bytes)
  if (!frame) {
    return
  }
  const listener = options.getListener(frame.streamId)
  if (!listener) {
    options.recordValidatedInboundTraffic()
    return
  }
  const maxFramePayloadBytes =
    options.maxFramePayloadBytes ?? MOBILE_TERMINAL_STREAM_FRAME_MAX_PAYLOAD_BYTES
  if (frame.payload.byteLength > maxFramePayloadBytes) {
    rejectSnapshot(options, listener, frame.streamId, 'Terminal stream frame exceeded size limit.')
    return
  }
  if (frame.opcode === TerminalStreamOpcode.Output) {
    options.recordValidatedInboundTraffic()
    listener({
      type: 'data',
      streamId: frame.streamId,
      chunk: decodeTerminalStreamText(frame.payload)
    })
    return
  }
  if (frame.opcode === TerminalStreamOpcode.SnapshotStart) {
    const meta = decodeTerminalStreamJson<Record<string, unknown>>(frame.payload)
    if (!meta) {
      return
    }
    const maxActiveSnapshots = options.maxActiveSnapshots ?? MOBILE_TERMINAL_SNAPSHOT_MAX_ACTIVE
    if (
      !options.terminalSnapshots.has(frame.streamId) &&
      options.terminalSnapshots.size >= maxActiveSnapshots
    ) {
      rejectSnapshot(options, listener, frame.streamId, 'Too many terminal snapshots are active.')
      return
    }
    options.recordValidatedInboundTraffic()
    options.terminalSnapshots.set(frame.streamId, {
      streamId: frame.streamId,
      meta,
      chunks: [],
      bytes: 0
    })
    return
  }
  if (frame.opcode === TerminalStreamOpcode.SnapshotChunk) {
    options.recordValidatedInboundTraffic()
    const snapshot = options.terminalSnapshots.get(frame.streamId)
    if (!snapshot) {
      return
    }
    const maxSnapshotBytes = options.maxSnapshotBytes ?? MOBILE_TERMINAL_SNAPSHOT_MAX_BYTES
    const maxSnapshotAggregateBytes =
      options.maxSnapshotAggregateBytes ?? MOBILE_TERMINAL_SNAPSHOT_MAX_AGGREGATE_BYTES
    const maxSnapshotChunks = options.maxSnapshotChunks ?? MOBILE_TERMINAL_SNAPSHOT_MAX_CHUNKS
    if (
      snapshot.chunks.length >= maxSnapshotChunks ||
      snapshot.bytes + frame.payload.byteLength > maxSnapshotBytes ||
      retainedSnapshotBytes(options.terminalSnapshots) + frame.payload.byteLength >
        maxSnapshotAggregateBytes
    ) {
      rejectSnapshot(options, listener, frame.streamId, 'Terminal snapshot exceeded size limit.')
      return
    }
    snapshot.chunks.push(decodeTerminalStreamText(frame.payload))
    snapshot.bytes += frame.payload.byteLength
    return
  }
  if (frame.opcode === TerminalStreamOpcode.SnapshotEnd) {
    options.recordValidatedInboundTraffic()
    const snapshot = options.terminalSnapshots.get(frame.streamId)
    if (!snapshot) {
      return
    }
    options.terminalSnapshots.delete(frame.streamId)
    const kind = snapshot.meta.kind === 'resized' ? 'resized' : 'scrollback'
    listener({
      ...snapshot.meta,
      type: kind,
      streamId: frame.streamId,
      serialized: snapshot.chunks.join('')
    })
    return
  }
  if (frame.opcode === TerminalStreamOpcode.Resized) {
    const meta = decodeTerminalStreamJson<Record<string, unknown>>(frame.payload)
    if (!meta) {
      return
    }
    options.recordValidatedInboundTraffic()
    listener({
      ...meta,
      type: 'resized',
      streamId: frame.streamId
    })
    return
  }
  if (frame.opcode === TerminalStreamOpcode.Metadata) {
    const meta = decodeTerminalStreamJson<Record<string, unknown>>(frame.payload)
    if (!meta) {
      return
    }
    options.recordValidatedInboundTraffic()
    listener({
      ...meta,
      type: 'metadata',
      streamId: frame.streamId
    })
    return
  }
  if (frame.opcode === TerminalStreamOpcode.Error) {
    options.recordValidatedInboundTraffic()
    listener({
      type: 'error',
      streamId: frame.streamId,
      message: decodeTerminalStreamText(frame.payload)
    })
  }
}
