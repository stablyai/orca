import {
  TERMINAL_MULTIPLEX_ACK_STREAM_MAX_WINDOW_BYTES,
  TERMINAL_MULTIPLEX_ACK_TOTAL_MAX_WINDOW_BYTES
} from '../../../../../shared/terminal-multiplex-flow-control'
import { drainTerminalMultiplexRoundRobin } from '../../terminal-multiplex-round-robin'
import {
  sendSnapshotFrames,
  serializeBudgetedRequestedSnapshot
} from './terminal-snapshot-publication'
import type {
  TerminalMultiplexConnection,
  TerminalMultiplexFlowControlStage,
  TerminalMultiplexFrameDeliveryStage
} from './terminal-multiplex-connection'
import type { TerminalMultiplexStream } from './terminal-stream-types'
import type { RemoteTerminalSourceRangeReplacementReservation } from '../../../remote-terminal-source-range-consumer'

export function installMultiplexFlowControl(
  build: TerminalMultiplexFrameDeliveryStage
): asserts build is TerminalMultiplexFlowControlStage {
  const state = build as TerminalMultiplexConnection
  const { runtime, streams } = state
  state.sendAckRecoverySnapshot = async (stream: TerminalMultiplexStream): Promise<void> => {
    if (
      state.closed ||
      streams.get(stream.streamId) !== stream ||
      stream.outputPaused ||
      stream.ackRecoverySnapshotInFlight
    ) {
      return
    }
    stream.ackRecoverySnapshotInFlight = true
    let replacement: RemoteTerminalSourceRangeReplacementReservation | null = null
    try {
      const serialized = await serializeBudgetedRequestedSnapshot(runtime, stream.ptyId, 0)
      if (state.closed || streams.get(stream.streamId) !== stream || stream.outputPaused) {
        return
      }
      if (!serialized) {
        throw new Error('Remote terminal recovery snapshot unavailable.')
      }
      if (
        stream.ackOutputSourceRanges &&
        (serialized.source === undefined || typeof serialized.seq !== 'number')
      ) {
        throw new Error('Remote terminal recovery snapshot source identity unavailable.')
      }
      if (
        stream.ackOutputSourceRanges &&
        serialized.source !== undefined &&
        typeof serialized.seq === 'number'
      ) {
        replacement = runtime.reserveRemoteTerminalSourceRangeReplacement(
          {
            ptyId: stream.ptyId,
            consumerId: stream.remoteDesktopSubscriptionKey,
            streamGeneration: stream.streamGeneration
          },
          serialized.seq,
          'ack-pending-overflow'
        )
        stream.sourceRangeReplacement = replacement
      }
      const displayMode = runtime.getMobileDisplayMode(stream.ptyId)
      const publication = sendSnapshotFrames(
        (opcode, payload) =>
          !state.closed &&
          streams.get(stream.streamId) === stream &&
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
          truncatedByByteBudget: serialized.truncatedByByteBudget,
          data: serialized.data
        }
      )
      if (!publication.published) {
        throw new Error('Remote terminal recovery snapshot was not published.')
      }
      if (state.closed || streams.get(stream.streamId) !== stream) {
        throw new Error('Remote terminal recovery snapshot stream detached.')
      }
      const localReplacement = replacement
        ? typeof serialized.seq === 'number'
          ? stream.sourceRangeLedger?.planSourceRangeReplacement(serialized.seq)
          : null
        : null
      if (replacement && !localReplacement) {
        throw new Error('Remote terminal recovery source ledger replacement unavailable.')
      }
      if (
        replacement &&
        (!serialized.source ||
          typeof serialized.seq !== 'number' ||
          !runtime.commitRemoteTerminalSourceRangeReplacement(replacement, {
            source: serialized.source,
            seq: serialized.seq
          }))
      ) {
        throw new Error('Remote terminal recovery snapshot replacement was not accepted.')
      }
      localReplacement?.commit()
      stream.sourceRangeReplacement = null
      replacement = null
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
    } catch (error) {
      if (replacement) {
        if (stream.sourceRangeReplacement === replacement) {
          stream.sourceRangeReplacement = null
          runtime.rollbackRemoteTerminalSourceRangeReplacement(
            replacement,
            'ack-pending-overflow-unpublished'
          )
        }
        replacement = null
      }
      if (state.closed || streams.get(stream.streamId) !== stream) {
        return
      }
      state.sendStreamError(
        stream.streamId,
        error instanceof Error ? error.message : 'Remote terminal recovery snapshot failed.'
      )
      state.detachStream(stream.streamId, true)
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
  state.acknowledgeSourceRanges = (
    stream: TerminalMultiplexStream,
    streamGeneration: string,
    ackedEndByte: number
  ): void => {
    if (!stream.ackOutputSourceRanges) {
      return
    }
    const result = stream.sourceRangeLedger?.acknowledge(streamGeneration, ackedEndByte)
    if (!result) {
      return
    }
    if (result.status !== 'accepted') {
      return
    }
    if (result.settled.length > 0) {
      runtime.settleRemoteTerminalSourceRanges(
        {
          ptyId: stream.ptyId,
          consumerId: stream.remoteDesktopSubscriptionKey,
          streamGeneration: stream.streamGeneration
        },
        result.settled
      )
    }
    state.acknowledgeOutput(stream, result.acknowledgedBytes)
  }
  state.detachSourceRangeConsumer = (stream: TerminalMultiplexStream, reason: string): void => {
    if (!stream.sourceRangeConsumerAttached) {
      return
    }
    stream.sourceRangeConsumerAttached = false
    const ledger = stream.sourceRangeLedger
    stream.sourceRangeLedger = null
    if (!ledger) {
      return
    }
    const identity = {
      ptyId: stream.ptyId,
      consumerId: stream.remoteDesktopSubscriptionKey,
      streamGeneration: stream.streamGeneration
    }
    const transfer = ledger.beginTransfer()
    const ranges = transfer.frames.flatMap((frame) => frame.sourceRanges)
    try {
      runtime.cancelRemoteTerminalSourceRanges(identity, ranges, reason)
    } finally {
      transfer.commit()
    }
  }
}
