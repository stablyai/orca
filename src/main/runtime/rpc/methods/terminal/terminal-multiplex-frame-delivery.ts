import {
  TerminalStreamOpcode,
  encodeTerminalInputAck,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson,
  encodeTerminalStreamText
} from '../../../../../shared/terminal-stream-protocol'
import { appendAckPendingOutput } from './terminal-stream-replay'
import { notePausedOutputDropped } from './terminal-multiplex-paused-output-drop'
import { settleDeliveredYieldedQueries } from './terminal-multiplex-yielded-queries'
import {
  isMultiplexStreamAttached,
  type TerminalMultiplexConnection
} from './terminal-multiplex-connection'
import type { TerminalOutputFrameChunk } from '../../terminal-output-frame-chunks'
import type { TerminalStreamInputOutcome } from './terminal-input-delivery'
import type { TerminalMultiplexStream } from './terminal-stream-types'
import type { RpcBinarySendResult } from '../../rpc-binary-sender'

export function installMultiplexFrameDelivery(state: TerminalMultiplexConnection): void {
  const { sendBinary, emit } = state
  state.sendFrame = (
    streamId: number,
    opcode: TerminalStreamOpcode,
    payload: Uint8Array<ArrayBufferLike> = new Uint8Array(),
    seq?: number
  ): boolean => {
    if (state.closed) {
      return false
    }
    // Seq-less Output uses sentinel zero; a control cursor would corrupt client drop tracking.
    const resolvedSeq =
      typeof seq === 'number' ? seq : opcode === TerminalStreamOpcode.Output ? 0 : state.cursor++
    let sent: RpcBinarySendResult
    try {
      sent = sendBinary(encodeTerminalStreamFrame({ opcode, streamId, seq: resolvedSeq, payload }))
    } catch {
      state.closeMultiplex()
      return false
    }
    if (sent === false) {
      // False means transport discarded the frame; only reconnect supplies an authoritative retry snapshot.
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
      !isMultiplexStreamAttached(state, stream) ||
      outcome !== 'rejected' ||
      !stream.supportsWriteUnavailable
    ) {
      return
    }
    state.sendFrame(stream.streamId, TerminalStreamOpcode.WriteUnavailable)
  }
  state.sendInputAck = (stream, appliedSeq, kind): void => {
    // Detached-stream clients resend on successors, which acknowledge again.
    if (!isMultiplexStreamAttached(state, stream) || stream.inputSessionId === null) {
      return
    }
    state.sendFrame(
      stream.streamId,
      TerminalStreamOpcode.InputAck,
      encodeTerminalInputAck(kind),
      appliedSeq
    )
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
      state.ackTotalInFlightBytes + bytes <= state.ackTotalWindowBytes
    )
  }
  state.sendAckGatedOutput = (
    stream: TerminalMultiplexStream,
    chunk: TerminalOutputFrameChunk
  ): boolean => {
    const sent = state.sendFrame(
      stream.streamId,
      chunk.opcode ?? TerminalStreamOpcode.Output,
      chunk.bytes,
      chunk.seq
    )
    if (!sent) {
      return false
    }
    settleDeliveredYieldedQueries(stream, chunk.seq)
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
    if (!isMultiplexStreamAttached(state, stream)) {
      return
    }
    if (stream.outputPaused) {
      notePausedOutputDropped(state, stream)
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
