import {
  TerminalStreamOpcode,
  encodeTerminalStreamJson
} from '../../../../../shared/terminal-stream-protocol'
import { recordYieldedTerminalQueries } from './terminal-multiplex-yielded-queries'
import { EMPTY_TERMINAL_REPLY_QUERY_SCAN_STATE } from '../../../../../shared/terminal-reply-query-scan'
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
    // Namespace client-local streamId by connection so sibling stream 1 floors cannot collide.
    remoteDesktopSubscriptionKey,
    pendingRemoteDesktopViewport: null,
    buffering: true,
    ackPendingOutput: [],
    ackPendingOutputBytes: 0,
    ackPendingOutputOverflowed: false,
    ackRecoverySnapshotInFlight: false,
    yieldedQueries: [],
    yieldedQueryScan: EMPTY_TERMINAL_REPLY_QUERY_SCAN_STATE,
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
      for (const chunk of iterateTerminalOutputFrameChunks(data, meta, 'span')) {
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
    recordYieldedTerminalQueries(runtime, stream, data, meta)
    if (stream.buffering) {
      appendPendingMultiplexOutput(stream, data, meta)
      return
    }
    stream.outputBatcher.push(data, meta)
  })
  // Remote xterm answers delivered queries; paused streams and unelected phones return reply authority to main.
  const releaseViewSubscriber = runtime.registerRemoteTerminalViewSubscriber(
    ptyId,
    () => stream.outputPaused,
    isMobile ? request.client?.id : undefined
  )
  // Report daemon death now, before the next refused keystroke.
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
    // Subscribe records cleanup/geometry without ownership; later activity claims it.
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
