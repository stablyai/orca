import {
  mobileSnapshotByteBudget,
  sendSnapshotFrames,
  serializeBudgetedMobileSnapshot,
  serializeStableMobileRendererSnapshot
} from './terminal-snapshot-publication'
import {
  getOutputAfterSnapshotSeq,
  isTerminalReadPayloadIncomplete,
  stripSnapshotBoundaryQuerySuffixes,
  trimPendingOutputCoveredBySnapshot
} from './terminal-stream-replay'
import type {
  TerminalSubscribeBinaryState,
  TerminalSubscriptionArgs
} from './terminal-subscribe-types'
import { deepenHeadlessCopyToDesktopDepth } from './headless-copy-desktop-depth'

const MOBILE_RENDERER_MOUNT_READY_TIMEOUT_MS = 3_000

export async function publishTerminalSubscribeBinarySnapshot(
  args: TerminalSubscriptionArgs,
  state: TerminalSubscribeBinaryState
): Promise<void> {
  const {
    params,
    runtime,
    registration,
    sendBinary,
    emit,
    ptyId,
    clientId,
    isMobile,
    missingHeadlessStateBeforeMobileFit,
    rendererMountRequestedBeforePty,
    serializerGenerationBeforeMobileFit
  } = args
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

  // Fit first so the seed uses the phone-owned grid.
  const hydratedFromRenderer =
    missingHeadlessStateBeforeMobileFit &&
    (await runtime.maybeHydrateHeadlessFromRenderer?.(ptyId)) === true
  if (state.closed) {
    return
  }
  let read = await runtime.readTerminal(params.terminal)
  // Share metadata with publication; re-read displayMode is omitted here and budgeted at its widest.
  const scrollbackFrame = { kind: 'scrollback' } as const
  let serialized = await serializeBudgetedMobileSnapshot(
    runtime,
    ptyId,
    mobileSnapshotByteBudget(params.snapshotByteBudget, state.streamId, scrollbackFrame)
  )
  if (state.closed) {
    return
  }
  // Missing model state, unlike blank text, means never-attached; null renderer answers fall back to mount wait even for stale host flags.
  const needsRendererScreen =
    missingHeadlessStateBeforeMobileFit &&
    !hydratedFromRenderer &&
    serialized?.source !== 'renderer'
  let rendererReady =
    needsRendererScreen &&
    (await runtime.serializeRendererTerminalBuffer(ptyId, { scrollbackRows: 0 })) !== null
  if (state.closed) {
    return
  }
  const mountRequested =
    needsRendererScreen &&
    !rendererReady &&
    (rendererMountRequestedBeforePty || runtime.requestRendererTerminalTabMount(params.terminal))
  if (mountRequested) {
    // Idle PTYs emit no later bytes; wait for evidence this remount settled before replay.
    const mountWaitController = new AbortController()
    const abortMountWait = (): void => mountWaitController.abort()
    state.abortRendererMountWait = abortMountWait
    if (signal.aborted) {
      abortMountWait()
    } else {
      signal.addEventListener('abort', abortMountWait, { once: true })
    }
    const rendererReadyPromise = runtime
      .waitForRendererTerminalSerializer(
        ptyId,
        serializerGenerationBeforeMobileFit,
        undefined,
        mountWaitController.signal
      )
      .catch(() => false)
    const finishMountWait = (): void => {
      signal.removeEventListener('abort', abortMountWait)
      if (state.abortRendererMountWait === abortMountWait) {
        state.abortRendererMountWait = () => {}
      }
    }
    void rendererReadyPromise.then(finishMountWait, finishMountWait)
    let deadlineTimer: ReturnType<typeof setTimeout> | null = null
    const initialDeadline = new Promise<boolean>((resolve) => {
      deadlineTimer = setTimeout(() => resolve(false), MOBILE_RENDERER_MOUNT_READY_TIMEOUT_MS)
      if (typeof deadlineTimer.unref === 'function') {
        deadlineTimer.unref()
      }
    })
    rendererReady = await Promise.race([rendererReadyPromise, initialDeadline])
    if (deadlineTimer) {
      clearTimeout(deadlineTimer)
    }
    if (state.closed || signal.aborted) {
      return
    }
    if (!rendererReady) {
      // Observe after the bounded initial response too, so an idle PTY can recover without output.
      state.lateRendererReadyPromise = rendererReadyPromise
    }
  }
  let rendererSeed: { seq?: number } | null = null
  if (rendererReady) {
    read = await runtime.readTerminal(params.terminal)
    const stableRendererSnapshot = await serializeStableMobileRendererSnapshot(
      runtime,
      ptyId,
      // Budget the scrollback frame actually sent below.
      mobileSnapshotByteBudget(params.snapshotByteBudget, state.streamId, scrollbackFrame)
    )
    if (state.closed) {
      return
    }
    // Blank may mean unhydrated; seq-less snapshots are safe only with no pending bytes that replay could duplicate.
    if (
      stableRendererSnapshot?.data.length &&
      (typeof stableRendererSnapshot.seq === 'number' || state.pendingOutput.length === 0)
    ) {
      serialized = stableRendererSnapshot
      const trailingOutput = state.pendingOutput.flatMap((item) => {
        const output = getOutputAfterSnapshotSeq(item, stableRendererSnapshot.seq)
        const seq = item.meta?.seq
        return output && typeof seq === 'number' ? [{ data: output.data, seq }] : []
      })
      runtime.replaceHeadlessTerminalFromRendererSnapshotForRecovery(
        ptyId,
        stableRendererSnapshot,
        trailingOutput
      )
      rendererSeed = stableRendererSnapshot
    }
  }
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
  const queryReplayData = state.pendingQueryOverflowed
    ? ''
    : state.pendingQuerySequences
        .filter(
          (query) =>
            initialOutputOverflowed ||
            (typeof snapshotOutputSeq === 'number' && query.startSeq < snapshotOutputSeq)
        )
        .map((query) => query.data)
        .join('')
  if (queryReplayData) {
    // Snapshots omit queries but trim their live chunks by seq; replay the post-snapshot query for one mobile response.
    state.outputBatcher.push(queryReplayData)
  }
  if (!initialOutputOverflowed) {
    for (const item of bufferedOutput) {
      const uncovered = getOutputAfterSnapshotSeq(item, snapshotOutputSeq)
      let uncoveredData = uncovered?.data ?? null
      let uncoveredMeta = uncovered?.meta
      if (
        uncoveredData &&
        uncoveredData !== item.data &&
        typeof snapshotOutputSeq === 'number' &&
        typeof item.meta?.seq === 'number' &&
        typeof item.meta.rawLength === 'number'
      ) {
        uncoveredData = stripSnapshotBoundaryQuerySuffixes(
          uncoveredData,
          snapshotOutputSeq,
          snapshotOutputSeq,
          state.pendingQuerySequences
        )
        if (!item.meta.transformed && item.meta.rawLength === item.data.length) {
          uncoveredMeta = { ...item.meta, rawLength: uncoveredData.length }
        }
      }
      if (uncoveredData) {
        state.outputBatcher.push(uncoveredData, uncoveredMeta)
      }
    }
  }
  state.pendingOutputBytes = 0
  state.outputBatcher.flush()
}
