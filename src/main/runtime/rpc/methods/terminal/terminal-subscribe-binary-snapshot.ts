import {
  mobileSnapshotByteBudget,
  sendSnapshotFrames,
  serializeBudgetedMobileSnapshot
} from './terminal-snapshot-publication'
import {
  getOutputAfterSnapshotSeq,
  isTerminalReadPayloadIncomplete,
  trimPendingOutputCoveredBySnapshot
} from './terminal-stream-replay'
import type {
  TerminalSubscribeBinaryState,
  TerminalSubscriptionArgs
} from './terminal-subscribe-types'
import { deepenHeadlessCopyToDesktopDepth } from './headless-copy-desktop-depth'

import { prepareMobileTerminalSnapshot } from './mobile-terminal-snapshot-preparation'

export async function publishTerminalSubscribeBinarySnapshot(
  args: TerminalSubscriptionArgs,
  state: TerminalSubscribeBinaryState
): Promise<void> {
  const { params, runtime, registration, sendBinary, emit, ptyId, clientId, isMobile } = args
  const { signal } = registration
  if (isMobile && clientId) {
    await registration.addMobilePresence(ptyId, clientId, params.viewport)
  } else if (clientId && params.viewport) {
    // Subscribe observes geometry; only explicit activity/claim may suppress the host.
    state.registeredRemoteDesktopDriver = true
    state.pendingRemoteDesktopViewport = params.viewport
  }
  if (state.closed) {
    return
  }

  const scrollbackFrame = { kind: 'scrollback' } as const
  const prepared = await prepareMobileTerminalSnapshot(
    args,
    state,
    signal,
    mobileSnapshotByteBudget(params.snapshotByteBudget, state.streamId, scrollbackFrame)
  )
  if (!prepared) {
    return
  }
  let { read, serialized } = prepared
  const { rendererSeed } = prepared
  let initialOutputOverflowed = false
  if (state.pendingOutputOverflowed) {
    state.pendingOutput.splice(0)
    state.pendingOutputBytes = 0
    state.pendingOutputOverflowed = false
    read = await runtime.readTerminal(params.terminal)
    serialized = await serializeBudgetedMobileSnapshot(
      runtime,
      ptyId,
      mobileSnapshotByteBudget(params.snapshotByteBudget, state.streamId, {
        kind: 'scrollback',
        displayMode: state.displayMode
      })
    )
    if (state.closed) {
      return
    }
    if (state.pendingOutputOverflowed) {
      initialOutputOverflowed = true
      state.pendingOutput.splice(0)
      state.pendingOutputBytes = 0
      state.pendingOutputOverflowed = false
    }
  }
  const size = runtime.getTerminalSize(ptyId)
  state.displayMode = runtime.getMobileDisplayMode(ptyId)
  // Layout seq is the mobile stale-event high-water; undefined is fail-open (docs/mobile-terminal-layout-state-machine.md).
  const layoutSeq = runtime.getLayout(ptyId)?.seq
  // Only output offsets cover buffered bytes; layout versions use a separate domain.
  let snapshotOutputSeq = serialized?.seq
  emit({
    type: 'subscribed',
    streamId: state.streamId,
    lines: read.tail,
    truncated: initialOutputOverflowed || (!sendBinary && isTerminalReadPayloadIncomplete(read)),
    cols: serialized?.cols ?? size?.cols,
    rows: serialized?.rows ?? size?.rows,
    displayMode: state.displayMode,
    seq: layoutSeq
  })
  const snapshotStats = sendSnapshotFrames(state.sendFrame, {
    ...scrollbackFrame,
    // Prefer client viewport to the unsized PTY's 80x24 stopgap, which exhausted mobile resubscribe attempts (STA-3337).
    cols: serialized?.cols ?? size?.cols ?? params.viewport?.cols ?? 80,
    rows: serialized?.rows ?? size?.rows ?? params.viewport?.rows ?? 24,
    displayMode: state.displayMode,
    seq: snapshotOutputSeq,
    cwd: serialized?.cwd,
    truncated: initialOutputOverflowed,
    truncatedByByteBudget: serialized?.truncatedByByteBudget,
    oscLinks: serialized?.oscLinks,
    alternateScreen: serialized?.alternateScreen,
    terminalOwner: serialized?.terminalOwner,
    lastTitle: serialized?.lastTitle,
    data: serialized?.data ?? ''
  })
  console.log('[mobile-terminal-stream] snapshot', {
    terminal: params.terminal,
    streamId: state.streamId,
    kind: 'scrollback',
    bytes: snapshotStats.bytes,
    chunks: snapshotStats.chunks,
    scrollbackRows: serialized?.scrollbackRows,
    truncatedByByteBudget: serialized?.truncatedByByteBudget === true
  })
  if (rendererSeed) {
    void deepenHeadlessCopyToDesktopDepth(runtime, ptyId, rendererSeed, () => !state.closed)
  }
  // Initial replay already rewrapped to these columns; seed resize replay gating.
  state.lastResizeCols = serialized?.cols ?? size?.cols
  let recoveryAttempts = 0
  // Use the recovery's actual resized frame for its budget.
  const recoveryFrame = { kind: 'resized', reason: 'pending-output-overflow' } as const
  // Pre-subscribe overflow dropped a middle segment; only a fresh model snapshot covers it.
  while (state.pendingOutputOverflowed && recoveryAttempts < 2) {
    state.pendingOutputOverflowed = false
    recoveryAttempts += 1
    const recovery = await serializeBudgetedMobileSnapshot(
      runtime,
      ptyId,
      mobileSnapshotByteBudget(params.snapshotByteBudget, state.streamId, recoveryFrame)
    )
    if (state.closed) {
      return
    }
    if (!recovery) {
      break
    }
    // Without output seq, retain bounded replay rather than an unverifiable renderer snapshot.
    if (typeof recovery.seq !== 'number') {
      break
    }
    // Clients ignore repeat scrollback but apply resized inline; omit output seq to avoid polluting layout seq filtering.
    const recoveryStats = sendSnapshotFrames(state.sendFrame, {
      ...recoveryFrame,
      cols: recovery.cols,
      rows: recovery.rows,
      displayMode: state.displayMode,
      source: recovery.source,
      truncated: false,
      truncatedByByteBudget: recovery.truncatedByByteBudget,
      data: recovery.data
    })
    console.log('[mobile-terminal-stream] recovery snapshot', {
      terminal: params.terminal,
      streamId: state.streamId,
      reason: 'pending-output-overflow',
      bytes: recoveryStats.bytes,
      chunks: recoveryStats.chunks,
      scrollbackRows: recovery.scrollbackRows,
      truncatedByByteBudget: recovery.truncatedByByteBudget === true
    })
    const trimmed = trimPendingOutputCoveredBySnapshot(state.pendingOutput, recovery.seq)
    state.pendingOutput = trimmed.chunks
    state.pendingOutputBytes = trimmed.bytes
    snapshotOutputSeq = recovery.seq
  }
  state.buffering = false
  const bufferedOutput = state.pendingOutput.splice(0)
  const initialQueries = state.initialQueryReplay.covered(
    snapshotOutputSeq,
    initialOutputOverflowed
  )
  const queryReplayData = initialQueries.map((query) => query.data).join('')
  if (queryReplayData) {
    // Snapshots omit queries but trim their live chunks by seq; replay the post-snapshot query for one mobile response.
    state.outputBatcher.push(queryReplayData)
  }
  if (!initialOutputOverflowed) {
    for (const item of bufferedOutput) {
      const uncovered = getOutputAfterSnapshotSeq(item, snapshotOutputSeq, initialQueries)
      if (uncovered?.data) {
        state.outputBatcher.push(uncovered.data, uncovered.meta)
      }
    }
  }
  state.pendingOutputBytes = 0
  state.outputBatcher.flush()
}
