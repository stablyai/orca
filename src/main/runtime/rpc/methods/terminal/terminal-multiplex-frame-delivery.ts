import {
  TerminalStreamOpcode,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson,
  encodeTerminalStreamText
} from '../../../../../shared/terminal-stream-protocol'
import { appendAckPendingOutput } from './terminal-stream-replay'
import type {
  TerminalMultiplexConnection,
  TerminalMultiplexConnectionBase,
  TerminalMultiplexFrameDeliveryStage
} from './terminal-multiplex-connection'
import type { TerminalOutputFrameChunk } from '../../terminal-output-frame-chunks'
import type { TerminalStreamInputOutcome } from './terminal-input-delivery'
import type { TerminalMultiplexStream } from './terminal-stream-types'

export function installMultiplexFrameDelivery(
  build: TerminalMultiplexConnectionBase
): asserts build is TerminalMultiplexFrameDeliveryStage {
  const state = build as TerminalMultiplexConnection
  const { sendBinary, emit, streams } = state
  state.sendFrame = (
    streamId: number,
    opcode: TerminalStreamOpcode,
    payload: Uint8Array<ArrayBufferLike> = new Uint8Array(),
    seq?: number,
    onRejected?: () => void
  ): boolean => {
    if (state.closed) {
      onRejected?.()
      return false
    }
    // Why: a seq-less Output chunk must carry sentinel 0, not the control-frame state.cursor, or it poisons the client's frame-drop tracker.
    const resolvedSeq =
      typeof seq === 'number' ? seq : opcode === TerminalStreamOpcode.Output ? 0 : state.cursor++
    let sent: boolean | void
    try {
      sent = sendBinary(encodeTerminalStreamFrame({ opcode, streamId, seq: resolvedSeq, payload }))
    } catch {
      onRejected?.()
      state.closeMultiplex()
      return false
    }
    if (sent === false) {
      onRejected?.()
      // Why: false means the transport discarded this frame; reconnect is the only available retry boundary with an authoritative snapshot.
      state.closeMultiplex()
      return false
    }
    return true
  }
  state.sendStreamError = (streamId: number, message: string): void => {
    state.sendFrame(streamId, TerminalStreamOpcode.Error, encodeTerminalStreamText(message))
    emit({ type: 'error', streamId, message })
  }
  state.notifyStreamWriteUnavailable = (
    stream: TerminalMultiplexStream,
    outcome: TerminalStreamInputOutcome
  ): void => {
    if (
      state.closed ||
      streams.get(stream.streamId) !== stream ||
      outcome !== 'rejected' ||
      !stream.supportsWriteUnavailable
    ) {
      return
    }
    state.sendFrame(stream.streamId, TerminalStreamOpcode.WriteUnavailable)
  }
  state.sendResizedFrame = (
    stream: TerminalMultiplexStream,
    event: { cols: number; rows: number; displayMode: string; reason: string; seq?: number }
  ): void => {
    stream.lastResizeCols = event.cols
    state.sendFrame(
      stream.streamId,
      TerminalStreamOpcode.Resized,
      encodeTerminalStreamJson({
        cols: event.cols,
        rows: event.rows,
        displayMode: event.displayMode,
        reason: event.reason,
        seq: event.seq
      })
    )
  }
  state.canSendAckGatedOutput = (stream: TerminalMultiplexStream, bytes: number): boolean => {
    if (!stream.ackOutput) {
      return true
    }
    return (
      stream.ackInFlightBytes + bytes <= stream.ackWindowBytes &&
      state.ackTotalInFlightBytes + bytes <= state.ackTotalWindowBytes &&
      (!stream.ackOutputSourceRanges || stream.sourceRangeLedger?.canAccept(bytes) === true)
    )
  }
  state.sendAckGatedOutput = (
    stream: TerminalMultiplexStream,
    chunk: TerminalOutputFrameChunk
  ): boolean => {
    const prepared = stream.ackOutputSourceRanges
      ? stream.sourceRangeLedger?.prepareAccept(
          chunk.bytes.byteLength,
          chunk.displayLength,
          chunk.sourceRanges ?? [],
          chunk.seq
        )
      : undefined
    if (stream.ackOutputSourceRanges && prepared?.status !== 'ready') {
      if (prepared?.status !== 'capacity') {
        state.detachStream(stream.streamId, true)
      }
      return false
    }
    const admission = prepared?.status === 'ready' ? prepared.admission : undefined
    const sent = state.sendFrame(
      stream.streamId,
      chunk.opcode ?? TerminalStreamOpcode.Output,
      chunk.bytes,
      chunk.seq,
      admission?.rollback
    )
    if (!sent) {
      return false
    }
    if (admission && !admission.commit()) {
      state.detachStream(stream.streamId, true)
      return false
    }
    if (stream.ackOutput) {
      stream.ackInFlightBytes += chunk.bytes.byteLength
      state.ackTotalInFlightBytes += chunk.bytes.byteLength
    }
    return true
  }
  state.queueOrSendOutput = (
    stream: TerminalMultiplexStream,
    chunk: TerminalOutputFrameChunk
  ): void => {
    if (state.closed || streams.get(stream.streamId) !== stream || stream.outputPaused) {
      return
    }
    if (
      stream.ackPendingOutputOverflowed ||
      stream.ackPendingOutput.length > 0 ||
      !state.canSendAckGatedOutput(stream, chunk.bytes.byteLength)
    ) {
      appendAckPendingOutput(stream, chunk)
      return
    }
    state.sendAckGatedOutput(stream, chunk)
  }
}
