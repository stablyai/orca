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
import type { TerminalMultiplexStream, TerminalOutputChunk } from './terminal-stream-types'
import {
  iterateTerminalOutputFrameChunks,
  type TerminalOutputFrameChunk
} from '../../terminal-output-frame-chunks'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamJson,
  decodeTerminalStreamText
} from '../../../../../shared/terminal-stream-protocol'
import { getOutputAfterSnapshotSeq } from './terminal-stream-replay'
import {
  markYieldedQueriesDiscardedInFrames,
  replaySnapshotCoveredQueries
} from './terminal-multiplex-yielded-queries'

export function reconcileMultiplexSnapshotOutput(
  state: TerminalMultiplexConnection,
  stream: TerminalMultiplexStream,
  snapshotSeq: number | undefined,
  pendingEscapeTailAnsi?: string,
  pendingOutput: readonly TerminalOutputChunk[] = []
): void {
  const snapshotOutput = [...pendingOutput]
  if (typeof snapshotSeq === 'number') {
    const discarded: TerminalOutputFrameChunk[] = []
    stream.ackPendingOutput = stream.ackPendingOutput.flatMap((chunk) => {
      if (typeof chunk.seq !== 'number') {
        return [chunk]
      }
      if (chunk.seq <= snapshotSeq) {
        discarded.push(chunk)
        return []
      }
      const span =
        chunk.opcode === TerminalStreamOpcode.OutputSpan
          ? decodeTerminalStreamJson<{ data: string; rawLength: number; transformed: boolean }>(
              chunk.bytes
            )
          : null
      const output = {
        data: span?.data ?? decodeTerminalStreamText(chunk.bytes),
        bytes: chunk.bytes.byteLength,
        meta: {
          seq: chunk.seq,
          rawLength: span?.rawLength ?? chunk.displayLength,
          transformed: span?.transformed
        }
      }
      const uncovered = getOutputAfterSnapshotSeq(output, snapshotSeq)
      if (uncovered === output) {
        return [chunk]
      }
      discarded.push(chunk)
      if (!uncovered) {
        snapshotOutput.push(output)
      }
      return uncovered
        ? Array.from(iterateTerminalOutputFrameChunks(uncovered.data, uncovered.meta, 'span'))
        : []
    })
    markYieldedQueriesDiscardedInFrames(stream, discarded)
    stream.ackPendingOutputBytes = stream.ackPendingOutput.reduce(
      (total, chunk) => total + chunk.bytes.byteLength,
      0
    )
  }
  replaySnapshotCoveredQueries(state, stream, snapshotOutput, snapshotSeq, pendingEscapeTailAnsi)
}

export function installMultiplexFlowControl(state: TerminalMultiplexConnection): void {
  const { runtime, streams } = state
  // Snapshots bypass ACK windows; restore history only after link drain so sustained floods cannot outrun intake.
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
      // Replace client history after dropped output; its retained history no longer reaches this screen.
      const carriesHistory = linkHasRoomForHistory(stream)
      const serialized = await serializeBudgetedRequestedSnapshot(
        runtime,
        stream.ptyId,
        carriesHistory ? TERMINAL_MULTIPLEX_RECOVERY_SCROLLBACK_ROWS : 0,
        stream.snapshotByteBudget
      )
      if (!isMultiplexStreamAttached(state, stream) || stream.outputPaused) {
        return
      }
      if (!serialized) {
        throw new Error('Remote terminal recovery snapshot unavailable.')
      }
      // Overflow still queues, so batched covered output reaches the cutoff below instead of settling queries the viewer drops.
      stream.outputBatcher.flush()
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
          pendingEscapeTailAnsi: serialized.pendingEscapeTailAnsi,
          kittyKeyboardFlags: serialized.kittyKeyboardFlags,
          alternateScreen: serialized.alternateScreen,
          terminalOwner: serialized.terminalOwner,
          lastTitle: serialized.lastTitle,
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
      stream.ackPendingOutputOverflowed = false
      stream.ackRecoveryHistoryOwed = !carriesHistory
      reconcileMultiplexSnapshotOutput(
        state,
        stream,
        serialized.seq,
        serialized.pendingEscapeTailAnsi
      )
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
