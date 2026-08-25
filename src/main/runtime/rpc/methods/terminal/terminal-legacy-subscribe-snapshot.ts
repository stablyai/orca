import {
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
  LegacyBinarySubscriptionState,
  TerminalSubscriptionArgs
} from './terminal-legacy-subscription-types'

const MOBILE_RENDERER_MOUNT_READY_TIMEOUT_MS = 3_000

export async function publishLegacyBinaryInitialSnapshot(
  args: TerminalSubscriptionArgs,
  state: LegacyBinarySubscriptionState
): Promise<void> {
  const {
    params,
    runtime,
    signal,
    sendBinary,
    emit,
    ptyId,
    clientId,
    isMobile,
    missingHeadlessStateBeforeMobileFit,
    rendererMountRequestedBeforePty,
    serializerGenerationBeforeMobileFit
  } = args
  if (isMobile && clientId) {
    await runtime.handleMobileSubscribe(ptyId, clientId, params.viewport)
  } else if (clientId && params.viewport) {
    // Why: legacy subscribe records geometry without taking ownership; only an explicit activity/claim frame may suppress the host.
    state.registeredRemoteDesktopDriver = true
    state.pendingRemoteDesktopViewport = params.viewport
  }
  if (state.closed) {
    return
  }

  let read = await runtime.readTerminal(params.terminal)
  let serialized = await serializeBudgetedMobileSnapshot(runtime, ptyId, isMobile)
  if (state.closed) {
    return
  }
  // Why: missing model state (not blank snapshot text) signals a never-attached PTY; a renderer-sourced snapshot already proves attachment, so skip the remount.
  const mountRequested =
    missingHeadlessStateBeforeMobileFit &&
    serialized?.source !== 'renderer' &&
    (rendererMountRequestedBeforePty || runtime.requestRendererTerminalTabMount(params.terminal))
  if (missingHeadlessStateBeforeMobileFit && mountRequested) {
    // Why: an idle legacy PTY emits no later byte, so wait for a settle proving this remount completed before replaying its screen.
    const mountWaitController = new AbortController()
    const abortMountWait = (): void => mountWaitController.abort()
    state.abortRendererMountWait = abortMountWait
    if (signal?.aborted) {
      abortMountWait()
    } else {
      signal?.addEventListener('abort', abortMountWait, { once: true })
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
      signal?.removeEventListener('abort', abortMountWait)
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
    const rendererReady = await Promise.race([rendererReadyPromise, initialDeadline])
    if (deadlineTimer) {
      clearTimeout(deadlineTimer)
    }
    if (state.closed || signal?.aborted) {
      return
    }
    if (rendererReady) {
      read = await runtime.readTerminal(params.terminal)
      const stableRendererSnapshot = await serializeStableMobileRendererSnapshot(runtime, ptyId)
      if (state.closed) {
        return
      }
      if (stableRendererSnapshot?.data.length) {
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
      }
    } else {
      // Why: a renderer can settle after the bounded initial response; keep observing so an idle PTY self-heals without bytes.
      state.lateRendererReadyPromise = rendererReadyPromise
    }
  }
  let initialOutputOverflowed = false
  if (state.pendingOutputOverflowed) {
    state.pendingOutput.splice(0)
    state.pendingOutputBytes = 0
    state.pendingOutputOverflowed = false
    read = await runtime.readTerminal(params.terminal)
    serialized = await serializeBudgetedMobileSnapshot(runtime, ptyId, isMobile)
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
  // Why: layout seq is the mobile stale-event filter's high-water mark (undefined pre-transition is fail-open). See docs/mobile-terminal-layout-state-machine.md.
  const layoutSeq = runtime.getLayout(ptyId)?.seq
  // Why: only an output offset can cover buffered chunks; layout versions are a separate sequence domain.
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
    kind: 'scrollback',
    // Why: prefer the subscriber's viewport over the 80x24 stopgap when the PTY has
    // no size yet — the mismatch made mobile burn its resubscribe budget (STA-3337).
    cols: serialized?.cols ?? size?.cols ?? params.viewport?.cols ?? 80,
    rows: serialized?.rows ?? size?.rows ?? params.viewport?.rows ?? 24,
    displayMode: state.displayMode,
    seq: snapshotOutputSeq,
    cwd: serialized?.cwd,
    truncated: initialOutputOverflowed,
    truncatedByByteBudget: serialized?.truncatedByByteBudget,
    oscLinks: serialized?.oscLinks,
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
  // Why: baseline for resize re-stream gating; the client already rewrapped to these cols via the initial snapshot replay.
  state.lastResizeCols = serialized?.cols ?? size?.cols
  let recoveryAttempts = 0
  // Why: if the bounded pre-subscribe tail overflowed, only a fresh model snapshot covers the dropped middle without replay gaps.
  while (state.pendingOutputOverflowed && recoveryAttempts < 2) {
    state.pendingOutputOverflowed = false
    recoveryAttempts += 1
    const recovery = await serializeBudgetedMobileSnapshot(runtime, ptyId, isMobile)
    if (state.closed) {
      return
    }
    if (!recovery) {
      break
    }
    // Why: without an output seq (renderer fallback) covered chunks can't be trimmed exactly, so keep the bounded replay over an unverifiable snapshot.
    if (typeof recovery.seq !== 'number') {
      break
    }
    // Why: clients drop a repeat scrollback snapshot but apply 'resized' inline; omit seq so output-byte seqs don't pollute the layout-seq filter.
    const recoveryStats = sendSnapshotFrames(state.sendFrame, {
      kind: 'resized',
      cols: recovery.cols,
      rows: recovery.rows,
      displayMode: state.displayMode,
      reason: 'pending-output-overflow',
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
    // Why: snapshots omit control queries but their seq trims the live chunk; replay the post-snapshot query so the mobile xterm answers once.
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
        if (item.meta.rawLength === item.data.length) {
          uncoveredMeta = { ...item.meta, rawLength: uncoveredData.length }
        }
        uncoveredData = stripSnapshotBoundaryQuerySuffixes(
          uncoveredData,
          snapshotOutputSeq,
          snapshotOutputSeq,
          state.pendingQuerySequences
        )
      }
      if (uncoveredData) {
        state.outputBatcher.push(uncoveredData, uncoveredMeta)
      }
    }
  }
  state.pendingOutputBytes = 0
  state.outputBatcher.flush()
}
