import {
  isTerminalSnapshotForcedUnavailable,
  sendSnapshotFrames,
  serializeBudgetedMobileSnapshot
} from './terminal-snapshot-publication'
import { getOutputAfterSnapshotSeq } from './terminal-stream-replay'
import { isMovedPaneHistorySessionId } from '../../../../../shared/orcad-migration/orcad-migration-terminal-history'
import {
  MOBILE_SUBSCRIBE_SCROLLBACK_ROWS,
  MOVED_PANE_SUBSCRIBE_SCROLLBACK_ROWS
} from '../../../scrollback-limits'
import { getTerminalInputSequenceLedger } from './terminal-input-sequence-ledger'
import {
  isMultiplexStreamAttached,
  type MultiplexSubscribeRequest,
  type TerminalMultiplexConnection
} from './terminal-multiplex-connection'
import type { TerminalMultiplexStream } from './terminal-stream-types'
import {
  discardPendingMultiplexOutput,
  replaySnapshotCoveredStatelessQueries
} from './terminal-multiplex-yielded-queries'

export type MultiplexPublishedInitialState = {
  isMobile: boolean
  size: { cols: number; rows: number } | null
  displayMode: string
}

export async function publishMultiplexInitialSnapshot(
  state: TerminalMultiplexConnection,
  request: MultiplexSubscribeRequest,
  stream: TerminalMultiplexStream,
  incarnationId = state.runtime.getPtyExecutionHostMetadata(stream.ptyId).incarnationId
): Promise<MultiplexPublishedInitialState | null> {
  const { runtime, emit } = state
  const { ptyId } = stream
  const isMobile = stream.isMobile
  const forcedInitialSnapshotTruncated =
    process.env.ORCA_E2E_FORCE_REMOTE_TERMINAL_INITIAL_SNAPSHOT_TRUNCATED === '1'
  // A WSL-moved pane replays its whole carried history once; the first view must hold all of it.
  const firstRows = isMovedPaneHistorySessionId(ptyId)
    ? MOVED_PANE_SUBSCRIBE_SCROLLBACK_ROWS
    : MOBILE_SUBSCRIBE_SCROLLBACK_ROWS
  let read = await runtime.readTerminal(request.terminal)
  let serialized = await serializeBudgetedMobileSnapshot(runtime, ptyId, undefined, firstRows)
  if (!isMultiplexStreamAttached(state, stream)) {
    return null
  }
  let initialOutputOverflowed = forcedInitialSnapshotTruncated
  if (stream.pendingOutputOverflowed) {
    discardPendingMultiplexOutput(stream)
    read = await runtime.readTerminal(request.terminal)
    serialized = await serializeBudgetedMobileSnapshot(runtime, ptyId, undefined, firstRows)
    if (!isMultiplexStreamAttached(state, stream)) {
      return null
    }
    if (stream.pendingOutputOverflowed) {
      initialOutputOverflowed = true
      discardPendingMultiplexOutput(stream)
    }
  }
  const size = runtime.getTerminalSize(ptyId)
  const displayMode = runtime.getMobileDisplayMode(ptyId)
  const layoutSeq = runtime.getLayout(ptyId)?.seq
  // Why: layout versions and output offsets are different sequence domains.
  const snapshotOutputSeq = serialized?.seq
  // Snapshot awaits may outlive the handle binding or the physical shell.
  if (
    runtime.resolveLiveLeafForHandle(request.terminal)?.ptyId !== ptyId ||
    runtime.getPtyExecutionHostMetadata(ptyId).incarnationId !== incarnationId
  ) {
    throw new Error('terminal_handle_stale')
  }
  let launchResult: ReturnType<typeof runtime.getTerminalLaunchResult>
  try {
    launchResult = runtime.getTerminalLaunchResult(ptyId)
  } catch (error) {
    console.warn('Terminal launch result unavailable', error)
  }
  emit({
    ...(incarnationId && launchResult
      ? { launchResult: { ...launchResult, ptyId, incarnationId } }
      : {}),
    type: 'subscribed',
    streamId: request.streamId,
    terminal: request.terminal,
    cols: serialized?.cols ?? size?.cols,
    rows: serialized?.rows ?? size?.rows,
    displayMode,
    seq: layoutSeq,
    ...((stream.supportsOutputPause || stream.inputSessionId !== null) && {
      capabilities: {
        ...(stream.supportsOutputPause ? { outputPause: 1 as const } : {}),
        ...(stream.supportsOutputPauseDropNotice ? { outputPauseDropNotice: 1 as const } : {}),
        ...(stream.inputSessionId !== null ? { inputAck: 1 as const } : {})
      }
    }),
    ...(stream.inputSessionId !== null
      ? { inputLedgerId: getTerminalInputSequenceLedger(runtime).id }
      : {}),
    // Truncated retained history does not invalidate the authoritative latest-screen fallback.
    truncated: initialOutputOverflowed
  })
  sendSnapshotFrames((opcode, payload) => state.sendFrame(request.streamId, opcode, payload), {
    kind: 'scrollback',
    cols: serialized?.cols ?? size?.cols ?? 80,
    rows: serialized?.rows ?? size?.rows ?? 24,
    displayMode,
    seq: snapshotOutputSeq,
    cwd: serialized?.cwd,
    truncated: initialOutputOverflowed,
    truncatedByByteBudget: serialized?.truncatedByByteBudget,
    scrollbackRows: serialized?.scrollbackRows,
    source: serialized?.source,
    kittyKeyboardFlags: serialized?.kittyKeyboardFlags,
    alternateScreen: serialized?.alternateScreen,
    terminalOwner: serialized?.terminalOwner,
    lastTitle: serialized?.lastTitle,
    oscLinks: serialized?.oscLinks,
    pendingEscapeTailAnsi: serialized?.pendingEscapeTailAnsi,
    // E2E: a forced-unavailable host retains nothing, so it has no tail to fall back on either.
    data:
      serialized?.data ??
      (read.tail.length > 0 && !isTerminalSnapshotForcedUnavailable()
        ? `${read.tail.join('\r\n')}\r\n`
        : '')
  })
  // Seed resize re-stream columns from the initial snapshot the client already rewrapped.
  stream.lastResizeCols = serialized?.cols ?? size?.cols
  stream.buffering = false
  const pendingOutput = stream.pendingOutput.splice(0)
  replaySnapshotCoveredStatelessQueries(
    state,
    stream,
    pendingOutput,
    snapshotOutputSeq,
    serialized?.pendingEscapeTailAnsi
  )
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
