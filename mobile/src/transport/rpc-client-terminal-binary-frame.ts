import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamJson,
  decodeTerminalStreamText,
  readTerminalStreamFrameId
} from '../../../src/shared/terminal-stream-protocol'
import type { TerminalUnreadableFrameResets } from './terminal-unreadable-frame-resets'

export type TerminalSnapshotState = {
  streamId: number
  meta: Record<string, unknown>
  chunks: string[]
}

type StreamingListener = (result: unknown) => void

type TerminalBinaryFrameOptions = {
  terminalSnapshots: Map<number, TerminalSnapshotState>
  unreadableFrames: TerminalUnreadableFrameResets
  getListener: (streamId: number) => StreamingListener | undefined
}

export function handleTerminalBinaryFrame(
  bytes: Uint8Array,
  options: TerminalBinaryFrameOptions
): void {
  const frame = decodeTerminalStreamFrame(bytes)
  if (!frame) {
    const streamId = readTerminalStreamFrameId(bytes)
    if (streamId !== null) {
      // A terminal frame this build can't read (unknown opcode) may carry output.
      reportUnreadableTerminalFrame(options, streamId, bytes[2] ?? -1)
    }
    return
  }
  const listener = options.getListener(frame.streamId)
  if (!listener) {
    return
  }
  if (frame.opcode === TerminalStreamOpcode.Output) {
    listener({
      type: 'data',
      streamId: frame.streamId,
      chunk: decodeTerminalStreamText(frame.payload)
    })
    return
  }
  if (frame.opcode === TerminalStreamOpcode.OutputSpan) {
    // Hosts before text-only terminal.subscribe send stripped-query output as a span.
    const span = decodeTerminalStreamJson<{ data?: unknown }>(frame.payload)
    if (typeof span?.data !== 'string') {
      reportUnreadableTerminalFrame(options, frame.streamId, frame.opcode)
      return
    }
    listener({ type: 'data', streamId: frame.streamId, chunk: span.data })
    return
  }
  if (frame.opcode === TerminalStreamOpcode.SnapshotStart) {
    const meta = decodeTerminalStreamJson<Record<string, unknown>>(frame.payload)
    if (!meta) {
      return
    }
    options.terminalSnapshots.set(frame.streamId, {
      streamId: frame.streamId,
      meta,
      chunks: []
    })
    return
  }
  if (frame.opcode === TerminalStreamOpcode.SnapshotChunk) {
    const snapshot = options.terminalSnapshots.get(frame.streamId)
    if (!snapshot) {
      return
    }
    snapshot.chunks.push(decodeTerminalStreamText(frame.payload))
    return
  }
  if (frame.opcode === TerminalStreamOpcode.SnapshotEnd) {
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
    listener({
      ...meta,
      type: 'metadata',
      streamId: frame.streamId
    })
    return
  }
  if (frame.opcode === TerminalStreamOpcode.Error) {
    listener({
      type: 'error',
      streamId: frame.streamId,
      message: decodeTerminalStreamText(frame.payload)
    })
    return
  }
  reportUnreadableTerminalFrame(options, frame.streamId, frame.opcode)
}

// Why an error event: ending the stream makes the next subscription redraw from a fresh snapshot.
function reportUnreadableTerminalFrame(
  options: TerminalBinaryFrameOptions,
  streamId: number,
  opcode: number
): void {
  if (!options.getListener(streamId)) {
    return
  }
  options.unreadableFrames.report(streamId, opcode, () => {
    // Re-read: a deferred reset must reach only the stream that is still live.
    const listener = options.getListener(streamId)
    if (!listener) {
      return
    }
    options.terminalSnapshots.delete(streamId)
    listener({
      type: 'error',
      streamId,
      message: `Unsupported terminal stream frame (opcode ${opcode}).`
    })
  })
}
