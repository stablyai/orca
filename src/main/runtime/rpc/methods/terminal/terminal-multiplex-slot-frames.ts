import {
  TerminalStreamOpcode,
  decodeTerminalStreamJson,
  type TerminalStreamFrame
} from '../../../../../shared/terminal-stream-protocol'
import {
  TerminalMultiplexLegacyAckFrame,
  TerminalMultiplexSnapshotRequestFrame
} from './stream-schemas'
import { getTerminalInputSequenceLedger } from './terminal-input-sequence-ledger'
import { handleMultiplexInputFrame } from './terminal-multiplex-input-frame'
import {
  getOutputAfterSnapshotSeq,
  normalizeMultiplexSnapshotScrollbackRows
} from './terminal-stream-replay'
import {
  sendSnapshotFrames,
  serializeBudgetedRequestedSnapshot
} from './terminal-snapshot-publication'
import { updateViewportForClient } from './terminal-viewport-update'
import { notePausedOutputDropped } from './terminal-multiplex-paused-output-drop'
import {
  isMultiplexStreamAttached,
  type MultiplexSnapshotRequest,
  type TerminalMultiplexConnection
} from './terminal-multiplex-connection'
import type { TerminalMultiplexStream, TerminalViewportClient } from './terminal-stream-types'

function decodeViewportFrame(
  payload: TerminalStreamFrame['payload']
): { cols: number; rows: number } | null {
  const viewport = decodeTerminalStreamJson<{ cols?: unknown; rows?: unknown }>(payload)
  return viewport && typeof viewport.cols === 'number' && typeof viewport.rows === 'number'
    ? { cols: viewport.cols, rows: viewport.rows }
    : null
}

export function installMultiplexSlotFrames(state: TerminalMultiplexConnection): void {
  const { runtime, streams } = state
  const inputSequenceLedger = getTerminalInputSequenceLedger(runtime)
  const applyStreamViewport = (
    stream: TerminalMultiplexStream,
    client: TerminalViewportClient,
    viewport: { cols: number; rows: number }
  ) =>
    updateViewportForClient(
      runtime,
      stream.ptyId,
      stream.remoteDesktopSubscriptionKey,
      client,
      viewport,
      stream.isMobile ? 'mobile' : 'desktop',
      'register',
      !stream.supportsDesktopViewportClaims
    )
  state.handleSlotFrame = (stream: TerminalMultiplexStream, frame: TerminalStreamFrame): void => {
    if (!isMultiplexStreamAttached(state, stream)) {
      return
    }
    if (frame.opcode === TerminalStreamOpcode.Unsubscribe) {
      state.cancelPendingPtyWaits(stream.streamId)
      state.detachStream(stream.streamId, null)
      return
    }
    if (frame.opcode === TerminalStreamOpcode.Ack) {
      const payload = decodeTerminalStreamJson<unknown>(frame.payload) ?? {}
      const parsed = TerminalMultiplexLegacyAckFrame.safeParse(payload)
      if (parsed.success) {
        state.acknowledgeOutput(stream, parsed.data.bytes)
      }
      return
    }
    if (frame.opcode === TerminalStreamOpcode.Input) {
      handleMultiplexInputFrame(state, inputSequenceLedger, stream, frame)
      return
    }
    if (frame.opcode === TerminalStreamOpcode.SetOutputPaused && stream.supportsOutputPause) {
      const payload = decodeTerminalStreamJson<{ paused?: unknown }>(frame.payload)
      if (typeof payload?.paused !== 'boolean' || stream.outputPaused === payload.paused) {
        return
      }
      stream.outputPaused = payload.paused
      if (stream.outputPaused) {
        stream.pausedOutputDropNoticeSent = false
        const discardsQueuedOutput =
          stream.ackPendingOutput.length > 0 || stream.ackPendingOutputOverflowed
        // Why: batched bytes flush into the paused gate, which reports them as dropped.
        stream.outputBatcher.flush()
        stream.ackPendingOutput = []
        stream.ackPendingOutputBytes = 0
        stream.ackPendingOutputOverflowed = false
        if (discardsQueuedOutput) {
          notePausedOutputDropped(state, stream)
        }
      }
      return
    }
    if (frame.opcode === TerminalStreamOpcode.Resize && stream.client) {
      const viewport = decodeViewportFrame(frame.payload)
      if (!viewport) {
        return
      }
      // Register stream geometry for detach cleanup; older clients cannot claim explicitly.
      if (!stream.isMobile && stream.client?.id) {
        stream.registeredRemoteDesktopDriver = true
        if (stream.buffering) {
          stream.pendingRemoteDesktopViewport = viewport
          return
        }
      }
      stream.desktopClaimTail = stream.desktopClaimTail
        .then(async (priorClaimed) => {
          const result = await applyStreamViewport(stream, stream.client!, viewport)
          return stream.supportsDesktopViewportClaims
            ? priorClaimed && result.applied
            : result.applied
        })
        .catch(() => false)
      return
    }
    if (frame.opcode === TerminalStreamOpcode.ClaimViewport && stream.client && !stream.isMobile) {
      const viewport = decodeViewportFrame(frame.payload)
      if (!viewport) {
        return
      }
      stream.registeredRemoteDesktopDriver = true
      const claim = () =>
        runtime.updateRemoteDesktopViewer(
          stream.ptyId,
          stream.remoteDesktopSubscriptionKey,
          stream.client!.id,
          viewport.cols,
          viewport.rows,
          true
        )
      stream.desktopClaimTail = stream.desktopClaimTail.then(claim, claim).catch(() => false)
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
    if (!isMultiplexStreamAttached(state, stream)) {
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
      if (!isMultiplexStreamAttached(state, stream)) {
        return
      }
      let size = runtime.getTerminalSize(stream.ptyId)
      let displayMode = runtime.getMobileDisplayMode(stream.ptyId)
      if (stream.pendingOutputOverflowed) {
        // Overflow tail is newer than the initial snapshot; request a current image rather than return null.
        stream.pendingOutput.splice(0)
        stream.pendingOutputBytes = 0
        stream.pendingOutputOverflowed = false
        serialized = await serializeBudgetedRequestedSnapshot(runtime, stream.ptyId, scrollbackRows)
        if (!isMultiplexStreamAttached(state, stream)) {
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
        scrollbackRows: serialized?.scrollbackRows,
        // No serializer answer does not prove emptiness; never publish an invented empty buffer.
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
            // Untagged snapshots reset live high-water, so suppress covered bytes; tagged side-consumer snapshots still owe live every chunk.
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
        // Apply resize parked during buffering now or it waits until the viewer resizes again.
        if (
          !stream.isMobile &&
          stream.client?.id &&
          stream.registeredRemoteDesktopDriver &&
          stream.pendingRemoteDesktopViewport
        ) {
          const viewport = stream.pendingRemoteDesktopViewport
          stream.pendingRemoteDesktopViewport = null
          void applyStreamViewport(stream, stream.client, viewport).catch(() => {})
        }
      }
    }
  }
}
