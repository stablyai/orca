import {
  TERMINAL_MULTIPLEX_ACK_BATCH_BYTES,
  TERMINAL_MULTIPLEX_ACK_STREAM_MAX_WINDOW_BYTES,
  TERMINAL_MULTIPLEX_ACK_TOTAL_MAX_WINDOW_BYTES,
  TERMINAL_MULTIPLEX_RECOVERY_SCROLLBACK_ROWS
} from '../../../../../shared/terminal-multiplex-flow-control'
import { drainTerminalMultiplexRoundRobin } from '../../terminal-multiplex-round-robin'
import {
  sendSnapshotFrames,
  serializeBudgetedRequestedSnapshot
} from './terminal-snapshot-publication'
import {
  isMultiplexStreamAttached,
  type TerminalMultiplexConnection
} from './terminal-multiplex-connection'
import type { TerminalMultiplexStream } from './terminal-stream-types'

export function installMultiplexFlowControl(state: TerminalMultiplexConnection): void {
  const { runtime, streams } = state
  // Why: snapshot frames bypass the ACK window, so only a drained link can afford history;
  // a recovery on every ACK of a sustained flood would otherwise outgrow the client's intake.
  const linkHasRoomForHistory = (stream: TerminalMultiplexStream): boolean =>
    stream.ackInFlightBytes <= TERMINAL_MULTIPLEX_ACK_BATCH_BYTES &&
    state.ackTotalInFlightBytes <= TERMINAL_MULTIPLEX_ACK_BATCH_BYTES
  state.sendAckRecoverySnapshot = async (stream: TerminalMultiplexStream): Promise<void> => {
    if (
      !isMultiplexStreamAttached(state, stream) ||
      stream.outputPaused ||
      stream.ackRecoverySnapshotInFlight
    ) {
      return
    }
    stream.ackRecoverySnapshotInFlight = true
    try {
      // Why history: output was dropped, so the client's own history ends before this screen and must be replaced, not kept.
      const carriesHistory = linkHasRoomForHistory(stream)
      const serialized = await serializeBudgetedRequestedSnapshot(
        runtime,
        stream.ptyId,
        carriesHistory ? TERMINAL_MULTIPLEX_RECOVERY_SCROLLBACK_ROWS : 0
      )
      if (!isMultiplexStreamAttached(state, stream) || stream.outputPaused) {
        return
      }
      if (!serialized) {
        throw new Error('Remote terminal recovery snapshot unavailable.')
      }
      const displayMode = runtime.getMobileDisplayMode(stream.ptyId)
      const publication = sendSnapshotFrames(
        (opcode, payload) =>
          isMultiplexStreamAttached(state, stream) &&
          state.sendFrame(stream.streamId, opcode, payload),
        {
          kind: 'scrollback',
          cols: serialized.cols,
          rows: serialized.rows,
          displayMode,
          reason: 'ack-pending-overflow',
          seq: serialized.seq,
          source: serialized.source,
          kittyKeyboardFlags: serialized.kittyKeyboardFlags,
          alternateScreen: serialized.alternateScreen,
          terminalOwner: serialized.terminalOwner,
          truncatedByByteBudget: serialized.truncatedByByteBudget,
          scrollbackRows: serialized.scrollbackRows,
          data: serialized.data
        }
      )
      if (!publication.published) {
        throw new Error('Remote terminal recovery snapshot was not published.')
      }
      if (!isMultiplexStreamAttached(state, stream)) {
        throw new Error('Remote terminal recovery snapshot stream detached.')
      }
      if (typeof serialized.seq === 'number') {
        const snapshotSeq = serialized.seq
        const retained = stream.ackPendingOutput.filter(
          (chunk) => !(typeof chunk.seq === 'number' && chunk.seq <= snapshotSeq)
        )
        stream.ackPendingOutput = retained
        stream.ackPendingOutputBytes = retained.reduce(
          (total, chunk) => total + chunk.bytes.byteLength,
          0
        )
      }
      stream.ackPendingOutputOverflowed = false
      stream.ackRecoveryHistoryOwed = !carriesHistory
    } catch (error) {
      if (!isMultiplexStreamAttached(state, stream)) {
        return
      }
      state.sendStreamError(
        stream.streamId,
        error instanceof Error ? error.message : 'Remote terminal recovery snapshot failed.'
      )
      state.detachStream(stream.streamId, 'unverifiable')
    } finally {
      if (streams.get(stream.streamId) === stream) {
        stream.ackRecoverySnapshotInFlight = false
        state.flushAllAckPendingOutput()
      }
    }
  }
  state.flushAckPendingOutput = (
    stream: TerminalMultiplexStream,
    maxChunks = Number.POSITIVE_INFINITY
  ): number => {
    if (stream.outputPaused) {
      return 0
    }
    if (stream.ackPendingOutputOverflowed) {
      void state.sendAckRecoverySnapshot(stream)
      return 0
    }
    let flushed = 0
    while (
      flushed < stream.ackPendingOutput.length &&
      flushed < maxChunks &&
      state.canSendAckGatedOutput(stream, stream.ackPendingOutput[flushed]!.bytes.byteLength)
    ) {
      if (!state.sendAckGatedOutput(stream, stream.ackPendingOutput[flushed]!)) {
        return flushed
      }
      flushed += 1
    }
    if (flushed > 0) {
      stream.ackPendingOutput.splice(0, flushed)
      stream.ackPendingOutputBytes = stream.ackPendingOutput.reduce(
        (total, pending) => total + pending.bytes.byteLength,
        0
      )
    }
    if (
      stream.ackRecoveryHistoryOwed &&
      stream.ackPendingOutput.length === 0 &&
      linkHasRoomForHistory(stream)
    ) {
      // The flood settled: one recovery now replaces the screen-only image and its history.
      stream.ackPendingOutputOverflowed = true
      void state.sendAckRecoverySnapshot(stream)
    }
    return flushed
  }
  state.flushAllAckPendingOutput = (): void => {
    const ordered = Array.from(streams.values())
    state.ackFlushCursorStreamId = drainTerminalMultiplexRoundRobin({
      streams: ordered,
      cursorStreamId: state.ackFlushCursorStreamId,
      canContinue: () => !state.closed,
      drainOne: (stream) => {
        if (streams.get(stream.streamId) !== stream) {
          return false
        }
        if (state.flushAckPendingOutput(stream, 1) > 0) {
          return true
        }
        return false
      }
    })
  }
  state.acknowledgeOutput = (stream: TerminalMultiplexStream, bytes: number): void => {
    if (!stream.ackOutput || bytes <= 0) {
      return
    }
    const acknowledged = Math.min(stream.ackInFlightBytes, bytes)
    stream.ackWindowBytes = Math.min(
      TERMINAL_MULTIPLEX_ACK_STREAM_MAX_WINDOW_BYTES,
      stream.ackWindowBytes + acknowledged
    )
    state.ackTotalWindowBytes = Math.min(
      TERMINAL_MULTIPLEX_ACK_TOTAL_MAX_WINDOW_BYTES,
      state.ackTotalWindowBytes + acknowledged
    )
    stream.ackInFlightBytes -= acknowledged
    state.ackTotalInFlightBytes = Math.max(0, state.ackTotalInFlightBytes - acknowledged)
    state.flushAllAckPendingOutput()
  }
}
