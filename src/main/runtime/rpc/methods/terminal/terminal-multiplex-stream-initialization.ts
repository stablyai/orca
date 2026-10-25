import {
  TerminalStreamOpcode,
  encodeTerminalStreamJson
} from '../../../../../shared/terminal-stream-protocol'
import { iterateTerminalOutputFrameChunks } from '../../terminal-output-frame-chunks'
import { TERMINAL_MULTIPLEX_ACK_STREAM_INITIAL_WINDOW_BYTES } from '../../../../../shared/terminal-multiplex-flow-control'
import { createTerminalOutputBatcher } from './terminal-output-batcher'
import { appendPendingMultiplexOutput } from './terminal-stream-replay'
import { updateViewportForClient } from './terminal-viewport-update'
import { notePausedOutputDropped } from './terminal-multiplex-paused-output-drop'
import {
  isMultiplexStreamAttached,
  type MultiplexSubscribeRequest,
  type TerminalMultiplexConnection
} from './terminal-multiplex-connection'
import type { TerminalMultiplexStream } from './terminal-stream-types'
import { subscribeToPtyEndpointLoss } from '../../../terminal/pty-endpoint-loss-signal'

export async function initializeMultiplexStream(
  state: TerminalMultiplexConnection,
  request: MultiplexSubscribeRequest,
  ptyId: string,
  onInstalled: (stream: TerminalMultiplexStream) => void
): Promise<TerminalMultiplexStream | null> {
  const { runtime, connectionId, streams, registerBinaryStreamHandler } = state
  const isMobile = request.client?.type === 'mobile'
  const remoteDesktopSubscriptionKey = `multiplex:${connectionId}:${request.streamId}`
  const stream: TerminalMultiplexStream = {
    streamId: request.streamId,
    terminal: request.terminal,
    ptyId,
    client: request.client,
    isMobile,
    ackOutput: request.capabilities?.ackOutput === 1,
    ackInFlightBytes: 0,
    ackWindowBytes: TERMINAL_MULTIPLEX_ACK_STREAM_INITIAL_WINDOW_BYTES,
    supportsOutputPause: request.capabilities?.outputPause === 1,
    supportsOutputPauseDropNotice:
      request.capabilities?.outputPause === 1 && request.capabilities.outputPauseDropNotice === 1,
    pausedOutputDropNoticeSent: false,
    supportsWriteUnavailable: request.capabilities?.writeUnavailable === 1,
    supportsEndpointLossNotice:
      request.capabilities?.writeUnavailable === 1 && request.capabilities.endpointLossNotice === 1,
    inputSessionId: request.capabilities?.inputAck === 1 ? (request.inputSessionId ?? null) : null,
    outputPaused: false,
    supportsDesktopViewportClaims: request.capabilities?.desktopViewportClaims === 1,
    desktopClaimTail: Promise.resolve(true),
    registeredRemoteDesktopDriver: false,
    // Why: streamId is client-local, so key the width floor by connectionId or two connections sharing stream 1 for one PTY clobber each other's floor.
    remoteDesktopSubscriptionKey,
    pendingRemoteDesktopViewport: null,
    buffering: true,
    ackPendingOutput: [],
    ackPendingOutputBytes: 0,
    ackPendingOutputOverflowed: false,
    ackRecoverySnapshotInFlight: false,
    ackRecoveryHistoryOwed: false,
    pendingOutput: [],
    pendingOutputBytes: 0,
    pendingOutputOverflowed: false,
    lastResizeCols: undefined,
    resizeGeneration: 0,
    outputBatcher: createTerminalOutputBatcher((data, meta) => {
      if (meta?.cwd !== undefined) {
        state.sendFrame(
          request.streamId,
          TerminalStreamOpcode.Metadata,
          encodeTerminalStreamJson({ cwd: meta.cwd }),
          meta.seq
        )
      }
      for (const chunk of iterateTerminalOutputFrameChunks(data, meta)) {
        state.queueOrSendOutput(stream, chunk)
      }
    }),
    unsubscribeData: () => {},
    unsubscribeResize: () => {},
    unsubscribeFit: () => {},
    unsubscribeDriver: () => {},
    unregisterBinaryHandler: () => {},
    exitWaiterAbort: new AbortController()
  }
  streams.set(request.streamId, stream)
  stream.unregisterBinaryHandler = registerBinaryStreamHandler(request.streamId, (frame) =>
    state.handleSlotFrame(stream, frame)
  )
  onInstalled(stream)

  const unsubscribeStreamData = runtime.subscribeToTerminalData(ptyId, (data, meta) => {
    if (!isMultiplexStreamAttached(state, stream)) {
      return
    }
    if (stream.outputPaused) {
      notePausedOutputDropped(state, stream)
      return
    }
    if (stream.buffering) {
      appendPendingMultiplexOutput(stream, data, meta)
      return
    }
    stream.outputBatcher.push(data, meta)
  })
  // Why: a multiplexed stream feeds a remote xterm view with query authority, so the main model responder yields while it receives output; a paused stream drops it, so main answers.
  const releaseViewSubscriber = runtime.registerRemoteTerminalViewSubscriber(
    ptyId,
    () => stream.outputPaused
  )
  // Why: the pane must hear its daemon died now, not when its next keystroke is refused.
  const unsubscribeEndpointLoss = stream.supportsEndpointLossNotice
    ? subscribeToPtyEndpointLoss(ptyId, () => {
        if (isMultiplexStreamAttached(state, stream)) {
          state.sendFrame(stream.streamId, TerminalStreamOpcode.WriteUnavailable)
        }
      })
    : () => {}
  stream.unsubscribeData = () => {
    releaseViewSubscriber()
    unsubscribeStreamData()
    unsubscribeEndpointLoss()
  }

  if (isMobile && request.client?.id) {
    await runtime.handleMobileSubscribe(ptyId, request.client.id, request.viewport)
  } else if (request.client?.id && request.viewport) {
    // Why: subscribe records this stream's geometry and cleanup key but doesn't claim ownership; activity frames claim later.
    stream.registeredRemoteDesktopDriver = true
    stream.pendingRemoteDesktopViewport = request.viewport
  }
  if (
    !isMobile &&
    request.client?.id &&
    stream.registeredRemoteDesktopDriver &&
    stream.pendingRemoteDesktopViewport
  ) {
    const viewport = stream.pendingRemoteDesktopViewport
    stream.pendingRemoteDesktopViewport = null
    await updateViewportForClient(
      runtime,
      ptyId,
      stream.remoteDesktopSubscriptionKey,
      request.client,
      viewport,
      'desktop',
      'register',
      !stream.supportsDesktopViewportClaims
    )
  }
  if (!isMultiplexStreamAttached(state, stream)) {
    return null
  }
  return stream
}
