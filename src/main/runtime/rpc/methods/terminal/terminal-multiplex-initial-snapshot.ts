import {
  sendSnapshotFrames,
  serializeBudgetedMobileSnapshot
} from './terminal-snapshot-publication'
import { getOutputAfterSnapshotSeq } from './terminal-stream-replay'
import type {
  MultiplexSubscribeRequest,
  TerminalMultiplexConnection
} from './terminal-multiplex-connection'
import type { TerminalMultiplexStream } from './terminal-stream-types'

export type MultiplexPublishedInitialState = {
  isMobile: boolean
  size: { cols: number; rows: number } | null
  displayMode: string
}

export async function publishMultiplexInitialSnapshot(
  state: TerminalMultiplexConnection,
  request: MultiplexSubscribeRequest,
  stream: TerminalMultiplexStream
): Promise<MultiplexPublishedInitialState | null> {
  const { runtime, streams, emit } = state
  const { ptyId } = stream
  const isMobile = stream.isMobile
  let read = await runtime.readTerminal(request.terminal)
  let serialized = await serializeBudgetedMobileSnapshot(runtime, ptyId, isMobile)
  if (state.closed || streams.get(request.streamId) !== stream) {
    return null
  }
  let initialOutputOverflowed = false
  if (stream.pendingOutputOverflowed) {
    stream.pendingOutput.splice(0)
    stream.pendingOutputBytes = 0
    stream.pendingOutputOverflowed = false
    read = await runtime.readTerminal(request.terminal)
    serialized = await serializeBudgetedMobileSnapshot(runtime, ptyId, isMobile)
    if (state.closed || streams.get(request.streamId) !== stream) {
      return null
    }
    if (stream.pendingOutputOverflowed) {
      initialOutputOverflowed = true
      stream.pendingOutput.splice(0)
      stream.pendingOutputBytes = 0
      stream.pendingOutputOverflowed = false
    }
  }
  const size = runtime.getTerminalSize(ptyId)
  const displayMode = runtime.getMobileDisplayMode(ptyId)
  const layoutSeq = runtime.getLayout(ptyId)?.seq
  // Why: layout versions and output offsets are different sequence domains.
  const snapshotOutputSeq = serialized?.seq
  emit({
    type: 'subscribed',
    streamId: request.streamId,
    terminal: request.terminal,
    cols: serialized?.cols ?? size?.cols,
    rows: serialized?.rows ?? size?.rows,
    displayMode,
    seq: layoutSeq,
    ...((stream.ackOutputSourceRanges || stream.supportsOutputPause) && {
      capabilities: {
        ...(stream.ackOutputSourceRanges ? { ackOutputSourceRanges: 1 as const } : {}),
        ...(stream.supportsOutputPause ? { outputPause: 1 as const } : {})
      }
    }),
    ...(stream.ackOutputSourceRanges ? { streamGeneration: stream.streamGeneration } : {}),
    // Why: retained-tail truncation loses history, not the authoritative latest-screen fallback.
    truncated: initialOutputOverflowed
  })
  stream.sourceRangeReplacement =
    stream.ackOutputSourceRanges &&
    serialized?.source !== undefined &&
    typeof serialized.seq === 'number'
      ? runtime.reserveRemoteTerminalSourceRangeReplacement(
          {
            ptyId,
            consumerId: stream.remoteDesktopSubscriptionKey,
            streamGeneration: stream.streamGeneration
          },
          serialized.seq,
          'initial-snapshot'
        )
      : null
  const snapshotPublication = sendSnapshotFrames(
    (opcode, payload) => state.sendFrame(request.streamId, opcode, payload),
    {
      kind: 'scrollback',
      cols: serialized?.cols ?? size?.cols ?? 80,
      rows: serialized?.rows ?? size?.rows ?? 24,
      displayMode,
      seq: snapshotOutputSeq,
      cwd: serialized?.cwd,
      truncated: initialOutputOverflowed,
      truncatedByByteBudget: serialized?.truncatedByByteBudget,
      source: serialized?.source,
      kittyKeyboardFlags: serialized?.kittyKeyboardFlags,
      alternateScreen: serialized?.alternateScreen,
      terminalOwner: serialized?.terminalOwner,
      oscLinks: serialized?.oscLinks,
      pendingEscapeTailAnsi: serialized?.pendingEscapeTailAnsi,
      data: serialized?.data ?? (read.tail.length > 0 ? `${read.tail.join('\r\n')}\r\n` : '')
    }
  )
  const replacement = stream.sourceRangeReplacement
  stream.sourceRangeReplacement = null
  if (replacement) {
    const committed =
      snapshotPublication.published &&
      serialized?.source !== undefined &&
      typeof serialized.seq === 'number' &&
      runtime.commitRemoteTerminalSourceRangeReplacement(replacement, {
        source: serialized.source,
        seq: serialized.seq
      })
    if (!committed) {
      runtime.rollbackRemoteTerminalSourceRangeReplacement(
        replacement,
        'initial-snapshot-unpublished'
      )
    }
  }
  // Why: baseline for resize re-stream gating; the client already rewrapped to these cols via the initial snapshot replay.
  stream.lastResizeCols = serialized?.cols ?? size?.cols
  stream.buffering = false
  const pendingOutput = stream.pendingOutput.splice(0)
  if (!initialOutputOverflowed) {
    for (const chunk of pendingOutput) {
      const uncovered = getOutputAfterSnapshotSeq(chunk, snapshotOutputSeq)
      if (uncovered) {
        stream.outputBatcher.push(uncovered.data, uncovered.meta)
      }
    }
  }
  stream.pendingOutputBytes = 0
  stream.pendingOutputOverflowed = false
  stream.outputBatcher.flush()
  return { isMobile, size, displayMode }
}
