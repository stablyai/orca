import {
  TerminalStreamOpcode,
  encodeTerminalStreamJson
} from '../../../../../shared/terminal-stream-protocol'
import {
  sendMobileResizeRestream,
  sendSnapshotFrames,
  serializeStableMobileRendererSnapshot
} from './terminal-snapshot-publication'
import { updateViewportForClient } from './terminal-viewport-update'
import type {
  LegacyBinarySubscriptionState,
  TerminalSubscriptionArgs
} from './terminal-legacy-subscription-types'

export function activateLegacyBinarySubscription(
  args: TerminalSubscriptionArgs,
  state: LegacyBinarySubscriptionState
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
        const recovery = await serializeStableMobileRendererSnapshot(runtime, ptyId)
        if (state.closed) {
          return
        }
        if (!recovery?.data.length) {
          return
        }
        // Why: late recovery has no buffered-output gate, so only an exact renderer high-water may reset mobile without erasing live bytes.
        if (recovery.seq !== runtime.getPtyOutputSequence(ptyId)) {
          return
        }
        runtime.replaceHeadlessTerminalFromRendererSnapshotForRecovery(ptyId, recovery)
        // Why: shipped mobile clients apply resized snapshots in place, so a blank xterm recovers without resubscribe.
        const recoveryStats = sendSnapshotFrames(state.sendFrame, {
          kind: 'resized',
          cols: recovery.cols,
          rows: recovery.rows,
          displayMode: state.displayMode,
          reason: 'renderer-mount-ready',
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
    // Why: xterm only re-wraps soft-wrapped lines, so a width change needs a full re-serialize+replay to rewrap restored hard-wrapped scrollback.
    const widthChanged = isMobile && event.cols !== state.lastResizeCols
    if (widthChanged) {
      state.lastResizeCols = event.cols
      void sendMobileResizeRestream(
        runtime,
        ptyId,
        state.sendFrame,
        event,
        () => !state.closed && state.resizeGeneration === eventGeneration
      )
        .then((restreamed) => {
          if (state.closed || state.resizeGeneration !== eventGeneration) {
            return
          }
          if (!restreamed) {
            sendResizedFrame(event)
          }
        })
        // Why: on re-stream failure, still emit the geometry-only Resized frame so the client never misses the resize.
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

  // Install the resize listener before draining the parked viewport, since applyLayout emits synchronously.
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

  // Legacy fit-override-changed for non-mobile (desktop) subscribers
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
