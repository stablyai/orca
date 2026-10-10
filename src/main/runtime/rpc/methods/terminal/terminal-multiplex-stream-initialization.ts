import { randomUUID } from 'node:crypto'
import {
  TerminalStreamOpcode,
  encodeTerminalStreamJson
} from '../../../../../shared/terminal-stream-protocol'
import { iterateTerminalOutputFrameChunks } from '../../terminal-output-frame-chunks'
import { TERMINAL_MULTIPLEX_ACK_STREAM_INITIAL_WINDOW_BYTES } from '../../../../../shared/terminal-multiplex-flow-control'
import { createTerminalOutputBatcher } from './terminal-output-batcher'
import { appendPendingMultiplexOutput } from './terminal-stream-replay'
import { updateViewportForClient } from './terminal-viewport-update'
import type {
  MultiplexSubscribeRequest,
  TerminalMultiplexConnection
} from './terminal-multiplex-connection'
import type { TerminalMultiplexStream } from './terminal-stream-types'

export async function initializeMultiplexStream(
  state: TerminalMultiplexConnection,
  request: MultiplexSubscribeRequest,
  ptyId: string,
  onInstalled: (stream: TerminalMultiplexStream) => void
): Promise<TerminalMultiplexStream | null> {
  const { runtime, connectionId, streams, sourceRangeRegistry, registerBinaryStreamHandler } = state
  const isMobile = request.client?.type === 'mobile'
  const remoteDesktopSubscriptionKey = `multiplex:${connectionId}:${request.streamId}`
  const streamGeneration = randomUUID()
  const requestedSourceRangeConsumer =
    request.capabilities?.ackOutput === 1 && request.capabilities?.ackOutputSourceRanges === 1
  const sourceRangeLedger = requestedSourceRangeConsumer
    ? sourceRangeRegistry.open(streamGeneration)
    : null
  const sourceRangeConsumerAttached =
    sourceRangeLedger !== null &&
    runtime.attachRemoteTerminalSourceRangeConsumer({
      ptyId,
      consumerId: remoteDesktopSubscriptionKey,
      streamGeneration
    })
  if (!sourceRangeConsumerAttached) {
    sourceRangeLedger?.close()
  }
  const stream: TerminalMultiplexStream = {
    streamId: request.streamId,
    terminal: request.terminal,
    ptyId,
    client: request.client,
    isMobile,
    ackOutput: request.capabilities?.ackOutput === 1,
    ackOutputSourceRanges: sourceRangeConsumerAttached,
    streamGeneration,
    sourceRangeLedger: sourceRangeConsumerAttached ? sourceRangeLedger : null,
    sourceRangeConsumerAttached,
    sourceRangeReplacement: null,
    ackInFlightBytes: 0,
    ackWindowBytes: TERMINAL_MULTIPLEX_ACK_STREAM_INITIAL_WINDOW_BYTES,
    supportsOutputPause: request.capabilities?.outputPause === 1,
    supportsWriteUnavailable: request.capabilities?.writeUnavailable === 1,
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
    if (state.closed || streams.get(request.streamId) !== stream) {
      return
    }
    if (stream.outputPaused) {
      return
    }
    if (stream.buffering) {
      appendPendingMultiplexOutput(stream, data, meta)
      return
    }
    stream.outputBatcher.push(data, meta)
  })
  // Why: a multiplexed stream feeds a remote xterm view with query authority, so the main model responder yields while attached (terminal-query-authority.md).
  const releaseViewSubscriber = runtime.registerRemoteTerminalViewSubscriber(ptyId)
  stream.unsubscribeData = () => {
    releaseViewSubscriber()
    unsubscribeStreamData()
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
  if (state.closed || streams.get(request.streamId) !== stream) {
    return null
  }
  return stream
}
