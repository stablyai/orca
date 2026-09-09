import {
  TerminalStreamOpcode,
  decodeTerminalStreamJson,
  decodeTerminalStreamText,
  type TerminalStreamFrame
} from '../../../../../shared/terminal-stream-protocol'
import {
  TerminalMultiplexLegacyAckFrame,
  TerminalMultiplexSnapshotRequestFrame,
  TerminalMultiplexSourceRangeAckFrame
} from './stream-schemas'
import { isTerminalInputLockedForClient, sendTerminalStreamInput } from './terminal-input-delivery'
import {
  getOutputAfterSnapshotSeq,
  normalizeMultiplexSnapshotScrollbackRows
} from './terminal-stream-replay'
import {
  sendSnapshotFrames,
  serializeBudgetedRequestedSnapshot
} from './terminal-snapshot-publication'
import { updateViewportForClient } from './terminal-viewport-update'
import type {
  MultiplexSnapshotRequest,
  TerminalMultiplexCleanupStage,
  TerminalMultiplexConnection,
  TerminalMultiplexSlotFramesStage
} from './terminal-multiplex-connection'
import type { TerminalMultiplexStream } from './terminal-stream-types'

export function installMultiplexSlotFrames(
  build: TerminalMultiplexCleanupStage
): asserts build is TerminalMultiplexSlotFramesStage {
  const state = build as TerminalMultiplexConnection
  const { runtime, streams } = state
  state.handleSlotFrame = (stream: TerminalMultiplexStream, frame: TerminalStreamFrame): void => {
    if (state.closed || streams.get(stream.streamId) !== stream) {
      return
    }
    if (frame.opcode === TerminalStreamOpcode.Unsubscribe) {
      state.cancelPendingPtyWaits(stream.streamId)
      state.detachStream(stream.streamId, null)
      return
    }
    if (frame.opcode === TerminalStreamOpcode.Ack) {
      const payload = decodeTerminalStreamJson<unknown>(frame.payload) ?? {}
      if (stream.ackOutputSourceRanges) {
        const parsed = TerminalMultiplexSourceRangeAckFrame.safeParse(payload)
        if (parsed.success) {
          state.acknowledgeSourceRanges(
            stream,
            parsed.data.streamGeneration,
            parsed.data.ackedEndByte
          )
        }
      } else {
        const parsed = TerminalMultiplexLegacyAckFrame.safeParse(payload)
        if (parsed.success) {
          state.acknowledgeOutput(stream, parsed.data.bytes)
        }
      }
      return
    }
    if (frame.opcode === TerminalStreamOpcode.Input) {
      const text = decodeTerminalStreamText(frame.payload)
      if (!text) {
        return
      }
      if (isTerminalInputLockedForClient(runtime, stream.ptyId, stream.client)) {
        return
      }
      // Mobile already has the higher-priority floor, so a rejected desktop claim must not suppress later phone input.
      const inputClaimTail = stream.isMobile ? Promise.resolve(true) : stream.desktopClaimTail
      void inputClaimTail.then(async (claimed) => {
        if (!claimed || isTerminalInputLockedForClient(runtime, stream.ptyId, stream.client)) {
          return
        }
        const outcome = await sendTerminalStreamInput(runtime, {
          terminal: stream.terminal,
          text,
          client: stream.client,
          isMobile: stream.isMobile
        })
        state.notifyStreamWriteUnavailable(stream, outcome)
      })
      return
    }
    if (frame.opcode === TerminalStreamOpcode.SetOutputPaused && stream.supportsOutputPause) {
      const payload = decodeTerminalStreamJson<{ paused?: unknown }>(frame.payload)
      if (typeof payload?.paused !== 'boolean' || stream.outputPaused === payload.paused) {
        return
      }
      stream.outputPaused = payload.paused
      if (stream.outputPaused) {
        stream.outputBatcher.flush()
        stream.ackPendingOutput = []
        stream.ackPendingOutputBytes = 0
        stream.ackPendingOutputOverflowed = false
      }
      return
    }
    if (frame.opcode === TerminalStreamOpcode.Resize && stream.client) {
      const viewport = decodeTerminalStreamJson<{ cols?: unknown; rows?: unknown }>(frame.payload)
      if (!viewport || typeof viewport.cols !== 'number' || typeof viewport.rows !== 'number') {
        return
      }
      const cols = viewport.cols
      const rows = viewport.rows
      // Why: resize registers stream-scoped geometry so detach can release it; older clients lack explicit claims.
      if (!stream.isMobile && stream.client?.id) {
        stream.registeredRemoteDesktopDriver = true
        if (stream.buffering) {
          stream.pendingRemoteDesktopViewport = { cols: viewport.cols, rows: viewport.rows }
          return
        }
      }
      stream.desktopClaimTail = stream.desktopClaimTail
        .then(async (priorClaimed) => {
          const result = await updateViewportForClient(
            runtime,
            stream.ptyId,
            stream.remoteDesktopSubscriptionKey,
            stream.client!,
            { cols, rows },
            stream.isMobile ? 'mobile' : 'desktop',
            'register',
            !stream.supportsDesktopViewportClaims
          )
          return stream.supportsDesktopViewportClaims
            ? priorClaimed && result.applied
            : result.applied
        })
        .catch(() => false)
      return
    }
    if (frame.opcode === TerminalStreamOpcode.ClaimViewport && stream.client && !stream.isMobile) {
      const viewport = decodeTerminalStreamJson<{ cols?: unknown; rows?: unknown }>(frame.payload)
      if (!viewport || typeof viewport.cols !== 'number' || typeof viewport.rows !== 'number') {
        return
      }
      const cols = viewport.cols
      const rows = viewport.rows
      stream.registeredRemoteDesktopDriver = true
      stream.desktopClaimTail = stream.desktopClaimTail
        .then(
          () =>
            runtime.updateRemoteDesktopViewer(
              stream.ptyId,
              stream.remoteDesktopSubscriptionKey,
              stream.client!.id,
              cols,
              rows,
              true
            ),
          () =>
            runtime.updateRemoteDesktopViewer(
              stream.ptyId,
              stream.remoteDesktopSubscriptionKey,
              stream.client!.id,
              cols,
              rows,
              true
            )
        )
        .catch(() => false)
      return
    }
    if (frame.opcode === TerminalStreamOpcode.SnapshotRequest) {
      const payload = TerminalMultiplexSnapshotRequestFrame.safeParse(
        decodeTerminalStreamJson<unknown>(frame.payload) ?? {}
      )
      void state.sendRequestedSnapshot(stream, payload.success ? payload.data : {})
    }
  }
  state.sendRequestedSnapshot = async (
    stream: TerminalMultiplexStream,
    request: MultiplexSnapshotRequest
  ): Promise<void> => {
    if (state.closed || streams.get(stream.streamId) !== stream) {
      return
    }
    stream.outputBatcher.flush()
    stream.pendingOutputOverflowed = false
    stream.buffering = true
    const requestId = request.requestId
    let sentSnapshotOutputSeq: number | undefined
    try {
      const scrollbackRows = normalizeMultiplexSnapshotScrollbackRows(request.scrollbackRows)
      let serialized = await serializeBudgetedRequestedSnapshot(
        runtime,
        stream.ptyId,
        scrollbackRows
      )
      if (state.closed || streams.get(stream.streamId) !== stream) {
        return
      }
      let size = runtime.getTerminalSize(stream.ptyId)
      let displayMode = runtime.getMobileDisplayMode(stream.ptyId)
      if (stream.pendingOutputOverflowed) {
        // Why: the overflowed tail is newer than the first snapshot, so retry for a current image instead of null.
        stream.pendingOutput.splice(0)
        stream.pendingOutputBytes = 0
        stream.pendingOutputOverflowed = false
        serialized = await serializeBudgetedRequestedSnapshot(runtime, stream.ptyId, scrollbackRows)
        if (state.closed || streams.get(stream.streamId) !== stream) {
          return
        }
        size = runtime.getTerminalSize(stream.ptyId)
        displayMode = runtime.getMobileDisplayMode(stream.ptyId)
        if (stream.pendingOutputOverflowed) {
          sendSnapshotFrames(
            (opcode, payload) => state.sendFrame(stream.streamId, opcode, payload),
            {
              kind: 'scrollback',
              cols: size?.cols ?? 80,
              rows: size?.rows ?? 24,
              requestId,
              displayMode,
              truncated: true,
              truncatedByByteBudget: false,
              unavailable: 'pending-output-overflowed',
              data: ''
            }
          )
          return
        }
      }
      sentSnapshotOutputSeq = serialized?.seq
      sendSnapshotFrames((opcode, payload) => state.sendFrame(stream.streamId, opcode, payload), {
        kind: 'scrollback',
        cols: serialized?.cols ?? size?.cols ?? 80,
        rows: serialized?.rows ?? size?.rows ?? 24,
        requestId,
        displayMode,
        seq: serialized?.seq,
        cwd: serialized?.cwd,
        source: serialized?.source,
        kittyKeyboardFlags: serialized?.kittyKeyboardFlags,
        alternateScreen: serialized?.alternateScreen,
        terminalOwner: serialized?.terminalOwner,
        oscLinks: serialized?.oscLinks,
        pendingEscapeTailAnsi: serialized?.pendingEscapeTailAnsi,
        truncated: false,
        truncatedByByteBudget: serialized?.truncatedByByteBudget,
        // Why: no serializer answered, which is not proof the pane is empty — say so instead of passing off '' as the buffer.
        unavailable: serialized ? undefined : 'no-serializable-buffer',
        data: serialized?.data ?? ''
      })
    } catch (error) {
      state.sendStreamError(
        stream.streamId,
        error instanceof Error ? error.message : 'Remote terminal snapshot failed.'
      )
    } finally {
      if (streams.get(stream.streamId) === stream) {
        const shouldFlushPendingOutput = !stream.pendingOutputOverflowed
        stream.buffering = false
        const pendingOutput = stream.pendingOutput.splice(0)
        if (shouldFlushPendingOutput) {
          for (const chunk of pendingOutput) {
            // Why: an untagged reply resets the client to the snapshot's
            // high-water, so covered bytes would render twice; tagged
            // snapshots feed a side consumer and the live view still
            // needs every buffered chunk.
            const uncovered =
              typeof requestId === 'number'
                ? chunk
                : getOutputAfterSnapshotSeq(chunk, sentSnapshotOutputSeq)
            if (uncovered) {
              stream.outputBatcher.push(uncovered.data, uncovered.meta)
            }
          }
        }
        stream.pendingOutputBytes = 0
        stream.pendingOutputOverflowed = false
        stream.outputBatcher.flush()
        // Why: a resize parked during snapshot buffering must be applied now, or it is dropped until the viewer's next resize.
        if (
          !stream.isMobile &&
          stream.client?.id &&
          stream.registeredRemoteDesktopDriver &&
          stream.pendingRemoteDesktopViewport
        ) {
          const viewport = stream.pendingRemoteDesktopViewport
          stream.pendingRemoteDesktopViewport = null
          void updateViewportForClient(
            runtime,
            stream.ptyId,
            stream.remoteDesktopSubscriptionKey,
            stream.client,
            viewport,
            'desktop',
            'register',
            !stream.supportsDesktopViewportClaims
          ).catch(() => {})
        }
      }
    }
  }
}
