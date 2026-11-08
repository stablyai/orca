import { TERMINAL_MULTIPLEX_RECOVERY_SCROLLBACK_ROWS } from '../../../../../shared/terminal/stream/terminal-multiplex-flow-control'
import { drainTerminalMultiplexRoundRobin } from '../../terminal-multiplex-round-robin'
import {
  sendSnapshotFrames,
  serializeBudgetedRequestedSnapshot
} from './terminal-snapshot-publication'
import {
  isMultiplexStreamAttached,
  type TerminalAckRecoveryCause,
  type TerminalMultiplexConnection
} from './terminal-multiplex-connection'
import type { TerminalMultiplexStream } from './terminal-stream-types'
import {
  ackLinkHasRoomForHistory,
  creditAckWindow,
  pacedAckWindowBytes
} from './terminal-multiplex-ack-window'
import type { TerminalOutputFrameChunk } from '../../terminal-output-frame-chunks'
import { framesAreSupersedable } from './terminal-multiplex-supersedable-frames'
import {
  markYieldedQueriesDiscardedInFrames,
  replaySnapshotCoveredStatelessQueries
} from './terminal-multiplex-yielded-queries'

const SUPERSEDE_UNAVAILABLE_BACKOFF_MS = 10_000
// Rejected backlogs are rescanned at most this often instead of on every ACK.
const SUPERSEDE_REJECTED_BACKOFF_MS = 1_000

export function installMultiplexFlowControl(state: TerminalMultiplexConnection): void {
  const { runtime, streams, linkEstimate } = state
  const linkHasRoomForHistory = (stream: TerminalMultiplexStream): boolean =>
    ackLinkHasRoomForHistory(state, stream)
  // Draining alt-screen frames a newer screen supersedes only delays echo; a viewport snapshot is cheaper.
  const snapshotSupersedesBacklog = (stream: TerminalMultiplexStream): boolean => {
    if (!linkEstimate.supersedesAltBacklog || stream.ackPendingOutput.length === 0) {
      return false
    }
    const paced = pacedAckWindowBytes(state, stream)
    if (
      paced === null ||
      stream.ackPendingOutputBytes <= paced ||
      linkEstimate.now() < stream.ackSupersedeSnapshotNotBefore
    ) {
      return false
    }
    if (!framesAreSupersedable(stream.ackSentOutputTail, stream.ackPendingOutput)) {
      stream.ackSupersedeSnapshotNotBefore = linkEstimate.now() + SUPERSEDE_REJECTED_BACKOFF_MS
      return false
    }
    return true
  }
  state.sendAckRecoverySnapshot = async (
    stream: TerminalMultiplexStream,
    cause: TerminalAckRecoveryCause = 'overflow'
  ): Promise<void> => {
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
      const carriesHistory = cause === 'overflow' && linkHasRoomForHistory(stream)
      const serialized = await serializeBudgetedRequestedSnapshot(
        runtime,
        stream.ptyId,
        carriesHistory ? TERMINAL_MULTIPLEX_RECOVERY_SCROLLBACK_ROWS : 0
      )
      if (!isMultiplexStreamAttached(state, stream) || stream.outputPaused) {
        return
      }
      if (!serialized && cause === 'superseded') {
        // Nothing was dropped, so the backlog still drains; back off instead of serializing per ACK.
        stream.ackSupersedeSnapshotNotBefore = linkEstimate.now() + SUPERSEDE_UNAVAILABLE_BACKOFF_MS
        return
      }
      if (!serialized) {
        throw new Error('Remote terminal recovery snapshot unavailable.')
      }
      // Overflow still queues, so batched covered output reaches the cutoff below instead of settling queries the viewer drops.
      stream.outputBatcher.flush()
      const isCovered = (chunk: TerminalOutputFrameChunk): boolean =>
        typeof serialized.seq === 'number' &&
        typeof chunk.seq === 'number' &&
        chunk.seq <= serialized.seq
      // An overflow while serializing already dropped output, so this recovery owes history like any overflow.
      const supersedesCleanly = cause === 'superseded' && !stream.ackPendingOutputOverflowed
      if (
        supersedesCleanly &&
        (serialized.alternateScreen !== true ||
          typeof serialized.seq !== 'number' ||
          // A snapshot cut inside an escape would print the queued suffix as text.
          Boolean(serialized.pendingEscapeTailAnsi) ||
          // The whole queue, so a marker split between covered and retained frames is still seen.
          !framesAreSupersedable(stream.ackSentOutputTail, stream.ackPendingOutput))
      ) {
        // The screen changed while serializing; drain rather than risk client history, and back off from re-serializing.
        stream.ackSupersedeSnapshotNotBefore = linkEstimate.now() + SUPERSEDE_UNAVAILABLE_BACKOFF_MS
        return
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
      if (linkEstimate.supersedesAltBacklog) {
        const rate = linkEstimate.deliveryBytesPerMs()
        // Snapshots bypass the ACK window, so cap superseding ones at half the measured link rate.
        stream.ackSupersedeSnapshotNotBefore =
          rate === null ? 0 : linkEstimate.now() + (2 * publication.bytes) / rate
        // A snapshot can end inside an escape (pendingEscapeTailAnsi), so the sent tail is unknown until text follows.
        stream.ackSentOutputTail = null
      }
      if (typeof serialized.seq === 'number') {
        markYieldedQueriesDiscardedInFrames(stream, stream.ackPendingOutput.filter(isCovered))
        const retained = stream.ackPendingOutput.filter((chunk) => !isCovered(chunk))
        stream.ackPendingOutput = retained
        stream.ackPendingOutputBytes = retained.reduce(
          (total, chunk) => total + chunk.bytes.byteLength,
          0
        )
      }
      // A clean supersede repaints alt only and leaves client history as-is.
      if (!supersedesCleanly) {
        stream.ackRecoveryHistoryOwed = !carriesHistory
      }
      stream.ackPendingOutputOverflowed = false
      replaySnapshotCoveredStatelessQueries(state, stream, [], serialized.seq)
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
    if (linkEstimate.supersedesAltBacklog && stream.ackRecoverySnapshotInFlight) {
      // A superseding snapshot is serializing; its cutoff will drop the covered backlog.
      return 0
    }
    if (snapshotSupersedesBacklog(stream)) {
      void state.sendAckRecoverySnapshot(stream, 'superseded')
      return 0
    }
    let flushed = 0
    while (
      flushed < stream.ackPendingOutput.length &&
      flushed < maxChunks &&
      state.canSendAckGatedOutput(stream, stream.ackPendingOutput[flushed]!.bytes.byteLength)
    ) {
      if (!state.sendAckGatedOutput(stream, stream.ackPendingOutput[flushed]!, true)) {
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
    const acknowledged = creditAckWindow(state, stream, bytes)
    if (linkEstimate.enabled) {
      linkEstimate.noteAcknowledged(stream, acknowledged)
    }
    state.flushAllAckPendingOutput()
  }
}
