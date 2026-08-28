import { sendMobileResizeRestream } from './terminal-snapshot-publication'
import { updateViewportForClient } from './terminal-viewport-update'
import type {
  MultiplexSubscribeRequest,
  TerminalMultiplexConnection
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
      // Why: re-serialize+replay the full scrollback at the new cols so restored hard-wrapped lines rewrap; live output resumes after the snapshot lands.
      void sendMobileResizeRestream(
        runtime,
        ptyId,
        (opcode, payload) => state.sendFrame(request.streamId, opcode, payload),
        event,
        () =>
          !state.closed &&
          streams.get(request.streamId) === stream &&
          stream.resizeGeneration === resizeGeneration
      )
        .then((restreamed) => {
          if (
            state.closed ||
            streams.get(request.streamId) !== stream ||
            stream.resizeGeneration !== resizeGeneration
          ) {
            return
          }
          if (!restreamed) {
            state.sendResizedFrame(stream, event)
          }
        })
        // Why: on re-stream failure, still emit the geometry-only Resized frame so the client never misses the resize.
        .catch(() => {
          if (
            state.closed ||
            streams.get(request.streamId) !== stream ||
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
    .then(() => {
      if (streams.get(request.streamId) === stream) {
        state.detachStream(request.streamId, true)
      }
    })
    .catch(() => {
      if (streams.get(request.streamId) === stream) {
        state.detachStream(request.streamId, true)
      }
    })
}
