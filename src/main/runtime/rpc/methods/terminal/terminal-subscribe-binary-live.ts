import {
  TerminalStreamOpcode,
  encodeTerminalStreamJson
} from '../../../../../shared/terminal-stream-protocol'
import {
  mobileSnapshotByteBudget,
  sendMobileResizeRestream,
  sendSnapshotFrames,
  serializeStableMobileRendererSnapshot
} from './terminal-snapshot-publication'
import { updateViewportForClient } from './terminal-viewport-update'
import type {
  TerminalSubscribeBinaryState,
  TerminalSubscriptionArgs
} from './terminal-subscribe-types'

export function activateTerminalSubscribeBinaryLive(
  args: TerminalSubscriptionArgs,
  state: TerminalSubscribeBinaryState
): void {
  const { params, runtime, emit, ptyId, clientId, isMobile, supportsDesktopViewportClaims } = args
  const lateRendererReady = state.lateRendererReadyPromise
  state.lateRendererReadyPromise = null
  if (lateRendererReady) {
    void lateRendererReady
      .then(async (rendererReady) => {
        if (!rendererReady || state.closed) {
          return
        }
        state.outputBatcher?.flush()
        // Share frame metadata with the budget; differing recovery reasons previously undercounted the frame.
        const recoveryFrame = { kind: 'resized', reason: 'renderer-mount-ready' } as const
        const recovery = await serializeStableMobileRendererSnapshot(
          runtime,
          ptyId,
          mobileSnapshotByteBudget(params.snapshotByteBudget, state.streamId, recoveryFrame)
        )
        if (state.closed) {
          return
        }
        if (!recovery?.data.length) {
          return
        }
        // Without buffered-output gating, only exact renderer high-water can reset the client without erasing live bytes.
        if (recovery.seq !== runtime.getPtyOutputSequence(ptyId)) {
          return
        }
        runtime.replaceHeadlessTerminalFromRendererSnapshotForRecovery(ptyId, recovery)
        // Shipped clients apply resized snapshots in place, recovering blank xterm without resubscribe.
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
        state.lastResizeCols = recovery.cols
        console.log('[mobile-terminal-stream] recovery snapshot', {
          terminal: params.terminal,
          streamId: state.streamId,
          reason: 'renderer-mount-ready',
          bytes: recoveryStats.bytes,
          chunks: recoveryStats.chunks,
          scrollbackRows: recovery.scrollbackRows,
          truncatedByByteBudget: recovery.truncatedByByteBudget === true
        })
      })
      .catch(() => {})
  }
  const sendResizedFrame = (event: {
    cols: number
    rows: number
    displayMode: string
    reason: string
    seq?: number
  }): void => {
    state.lastResizeCols = event.cols
    state.sendFrame(
      TerminalStreamOpcode.Resized,
      encodeTerminalStreamJson({
        cols: event.cols,
        rows: event.rows,
        displayMode: event.displayMode,
        reason: event.reason,
        seq: event.seq
      })
    )
  }
  state.unsubscribeResize = runtime.subscribeToTerminalResize(ptyId, (event) => {
    state.outputBatcher?.flush()
    const eventGeneration = state.resizeGeneration + 1
    state.resizeGeneration = eventGeneration
    // Restored hard newlines need full reserialization/replay at the new width; xterm rewraps only soft wraps.
    const widthChanged = isMobile && event.cols !== state.lastResizeCols
    if (widthChanged) {
      state.lastResizeCols = event.cols
      void sendMobileResizeRestream(
        runtime,
        ptyId,
        state.sendFrame,
        event,
        () => !state.closed && state.resizeGeneration === eventGeneration,
        mobileSnapshotByteBudget(params.snapshotByteBudget, state.streamId, {
          kind: 'resized',
          displayMode: event.displayMode,
          reason: event.reason
        })
      )
        .then((restreamed) => {
          if (state.closed || state.resizeGeneration !== eventGeneration) {
            return
          }
          if (!restreamed) {
            sendResizedFrame(event)
          }
        })
        // Even failed replay must report geometry.
        .catch(() => {
          if (state.closed || state.resizeGeneration !== eventGeneration) {
            return
          }
          sendResizedFrame(event)
        })
      return
    }
    sendResizedFrame(event)
  })

  // Install before draining the parked viewport: applyLayout emits synchronously.
  if (
    clientId &&
    params.client &&
    state.registeredRemoteDesktopDriver &&
    state.pendingRemoteDesktopViewport
  ) {
    const viewport = state.pendingRemoteDesktopViewport
    state.pendingRemoteDesktopViewport = null
    void updateViewportForClient(
      runtime,
      ptyId,
      state.remoteDesktopSubscriptionKey,
      params.client,
      viewport,
      'desktop',
      'register',
      !supportsDesktopViewportClaims
    ).catch(() => {})
  }

  state.unsubscribeFit = !isMobile
    ? runtime.subscribeToFitOverrideChanges(ptyId, (event) => {
        const mode =
          event.mode === 'mobile-fit'
            ? event.mode
            : (runtime.getRemoteDesktopFitHold?.(ptyId, state.remoteDesktopSubscriptionKey).mode ??
              'desktop-fit')
        emit({
          type: 'fit-override-changed',
          mode,
          cols: event.cols,
          rows: event.rows
        })
      })
    : () => {}
}
