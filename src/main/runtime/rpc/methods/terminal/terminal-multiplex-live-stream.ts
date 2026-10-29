import { sendMobileResizeRestream } from './terminal-snapshot-publication'
import { updateViewportForClient } from './terminal-viewport-update'
import {
  isMultiplexStreamAttached,
  type MultiplexSubscribeRequest,
  type TerminalMultiplexConnection
} from './terminal-multiplex-connection'
import type { MultiplexPublishedInitialState } from './terminal-multiplex-initial-snapshot'
import type { TerminalMultiplexStream } from './terminal-stream-types'

export function activateMultiplexStream(
  state: TerminalMultiplexConnection,
  request: MultiplexSubscribeRequest,
  stream: TerminalMultiplexStream,
  published: MultiplexPublishedInitialState
): void {
  const { runtime, streams, emit } = state
  const { ptyId } = stream
  const { isMobile, size } = published
  if (!isMobile) {
    stream.unsubscribeFit = runtime.subscribeToFitOverrideChanges(ptyId, (event) => {
      const mode =
        event.mode === 'mobile-fit'
          ? event.mode
          : (runtime.getRemoteDesktopFitHold?.(ptyId, stream.remoteDesktopSubscriptionKey).mode ??
            'desktop-fit')
      emit({
        type: 'fit-override-changed',
        streamId: request.streamId,
        mode,
        cols: event.cols,
        rows: event.rows
      })
    })
    stream.unsubscribeDriver = runtime.subscribeToDriverChanges(ptyId, (driver) => {
      emit({
        type: 'driver-changed',
        streamId: request.streamId,
        driver
      })
    })
    const fitOverride = runtime.getTerminalFitOverride(ptyId)
    const desktopHold = runtime.getRemoteDesktopFitHold?.(
      ptyId,
      stream.remoteDesktopSubscriptionKey
    ) ?? { mode: 'desktop-fit' as const, cols: size?.cols ?? 0, rows: size?.rows ?? 0 }
    emit({
      type: 'fit-override-changed',
      streamId: request.streamId,
      mode: fitOverride?.mode ?? desktopHold.mode,
      cols: fitOverride?.cols ?? desktopHold.cols,
      rows: fitOverride?.rows ?? desktopHold.rows
    })
    emit({
      type: 'driver-changed',
      streamId: request.streamId,
      driver: runtime.getDriver(ptyId)
    })
  }
  stream.unsubscribeResize = runtime.subscribeToTerminalResize(ptyId, (event) => {
    stream.outputBatcher.flush()
    const resizeGeneration = stream.resizeGeneration + 1
    stream.resizeGeneration = resizeGeneration
    const widthChanged = stream.isMobile && event.cols !== stream.lastResizeCols
    if (widthChanged) {
      stream.lastResizeCols = event.cols
      // Replay full scrollback at new columns to rewrap restored hard lines before live output resumes.
      void sendMobileResizeRestream(
        runtime,
        ptyId,
        (opcode, payload) => state.sendFrame(request.streamId, opcode, payload),
        event,
        () =>
          isMultiplexStreamAttached(state, stream) && stream.resizeGeneration === resizeGeneration
      )
        .then((restreamed) => {
          if (
            !isMultiplexStreamAttached(state, stream) ||
            stream.resizeGeneration !== resizeGeneration
          ) {
            return
          }
          if (!restreamed) {
            state.sendResizedFrame(stream, event)
          }
        })
        // Still emit geometry-only Resized when snapshot replay fails.
        .catch(() => {
          if (
            !isMultiplexStreamAttached(state, stream) ||
            stream.resizeGeneration !== resizeGeneration
          ) {
            return
          }
          state.sendResizedFrame(stream, event)
        })
      return
    }
    state.sendResizedFrame(stream, event)
  })
  // Install the resize listener before draining the parked viewport, since applyLayout emits synchronously.
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
      ptyId,
      stream.remoteDesktopSubscriptionKey,
      stream.client,
      viewport,
      'desktop',
      'register',
      !stream.supportsDesktopViewportClaims
    ).catch(() => {})
  }
  void runtime
    .waitForTerminal(request.terminal, {
      condition: 'exit',
      signal: stream.exitWaiterAbort.signal
    })
    .then((wait) => {
      if (streams.get(request.streamId) === stream) {
        state.detachStream(
          request.streamId,
          wait.satisfied && wait.condition === 'exit' && wait.status === 'exited'
            ? 'exited'
            : 'unverifiable'
        )
      }
    })
    .catch(() => {
      if (streams.get(request.streamId) === stream) {
        state.detachStream(request.streamId, 'unverifiable')
      }
    })
}
