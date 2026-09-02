import {
  TerminalStreamOpcode,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson
} from '../../../../../shared/terminal-stream-protocol'
import { iterateTerminalOutputFrameChunks } from '../../terminal-output-frame-chunks'
import {
  EMPTY_TERMINAL_REPLY_QUERY_SCAN_STATE,
  scanTerminalReplyQuerySequences,
  type TerminalReplyQueryScanState,
  type TerminalReplyQuerySequence
} from '../../../../../shared/terminal-reply-query-scan'
import { TERMINAL_MULTIPLEX_PENDING_MAX_BYTES } from '../../../../../shared/terminal-multiplex-flow-control'
import { measureTerminalStreamByteLength } from '../../terminal-stream-byte-length'
import { createTerminalOutputBatcher, type TerminalOutputBatcher } from './terminal-output-batcher'
import { watchSubscriptionLifetime } from './terminal-input-delivery'
import { trimPendingOutputToBudget } from './terminal-stream-replay'
import { allocateTerminalSubscriptionStreamId } from './terminal-subscription-stream-id'
import type {
  LegacyBinarySubscriptionState,
  TerminalSubscriptionArgs
} from './terminal-legacy-subscription-types'
import type { TerminalOutputChunk } from './terminal-stream-types'
import { publishLegacyBinaryInitialSnapshot } from './terminal-legacy-subscribe-snapshot'
import { activateLegacyBinarySubscription } from './terminal-legacy-subscribe-live'
import { registerLegacyBinaryControlFrames } from './terminal-legacy-binary-control-frames'
const TERMINAL_QUERY_REPLAY_MAX_CHARS = 16 * 1024
export async function runTerminalBinarySubscription(args: TerminalSubscriptionArgs): Promise<void> {
  const { params, runtime, connectionId, sendBinary, signal, emit, ptyId, clientId, isMobile } =
    args
  if (!sendBinary) {
    throw new Error('binary_terminal_stream_required')
  }
  let registeredRemoteDesktopDriver = false
  const streamId = allocateTerminalSubscriptionStreamId()
  const remoteDesktopSubscriptionKey = `stream:${streamId}`
  let cursor = 0
  let closed = false
  let buffering = true
  let pendingRemoteDesktopViewport: { cols: number; rows: number } | null = null
  let lastResizeCols: number | undefined
  let resizeGeneration = 0
  let pendingOutput: TerminalOutputChunk[] = []
  let desktopClaimTail: Promise<boolean> = Promise.resolve(true)
  let pendingOutputBytes = 0
  let pendingOutputOverflowed = false
  let pendingQueryScanState: TerminalReplyQueryScanState = EMPTY_TERMINAL_REPLY_QUERY_SCAN_STATE
  const pendingQuerySequences: TerminalReplyQuerySequence[] = []
  let pendingQueryChars = 0
  let pendingQueryOverflowed = false
  let unsubscribeData = (): void => {}
  let unsubscribeResize = (): void => {}
  let unsubscribeFit = (): void => {}
  let unregisterBinaryHandler = (): void => {}
  let abortRendererMountWait = (): void => {}
  let stopWatchingLifetime = (): void => {}
  let lateRendererReadyPromise: Promise<boolean> | null = null
  let outputBatcher: TerminalOutputBatcher | null = null
  let resolveStream = (): void => {}
  const streamClosed = new Promise<void>((resolve) => {
    resolveStream = resolve
  })
  // Why: register cleanup before any await so a mid-subscribe disconnect still removes mobile presence; client-scoped ids also allow parallel desktop subscribers.
  const subscriptionId = clientId ? `${params.terminal}:${clientId}` : params.terminal
  const registration = runtime.registerOwnedSubscriptionCleanup(
    subscriptionId,
    () => {
      stopWatchingLifetime()
      outputBatcher?.flush()
      outputBatcher?.dispose()
      closed = true
      unsubscribeData()
      unsubscribeResize()
      unsubscribeFit()
      unregisterBinaryHandler()
      abortRendererMountWait()
      if (isMobile && clientId) {
        runtime.handleMobileUnsubscribe(ptyId, clientId)
      } else if (registeredRemoteDesktopDriver && clientId) {
        runtime.unregisterRemoteDesktopViewer(ptyId, remoteDesktopSubscriptionKey)
      }
      emit({ type: 'end' })
      resolveStream()
    },
    connectionId
  )
  stopWatchingLifetime = watchSubscriptionLifetime(runtime, ptyId, signal, registration)
  if (closed) {
    // Why: an already-exited pty releases synchronously, so cleanup ran before this setup registers anything.
    return
  }
  const sendFrame = (
    opcode: TerminalStreamOpcode,
    payload: Uint8Array<ArrayBufferLike> = new Uint8Array(),
    frameSeq = cursor++
  ): void => {
    if (closed || !sendBinary) {
      return
    }
    sendBinary(encodeTerminalStreamFrame({ opcode, streamId, seq: frameSeq, payload }))
  }
  outputBatcher = createTerminalOutputBatcher((data, meta) => {
    if (meta?.cwd !== undefined) {
      sendFrame(
        TerminalStreamOpcode.Metadata,
        encodeTerminalStreamJson({ cwd: meta.cwd }),
        meta.seq
      )
    }
    for (const chunk of iterateTerminalOutputFrameChunks(data, meta)) {
      sendFrame(chunk.opcode ?? TerminalStreamOpcode.Output, chunk.bytes, chunk.seq)
    }
  })
  unregisterBinaryHandler = registerLegacyBinaryControlFrames(
    args,
    streamId,
    remoteDesktopSubscriptionKey,
    {
      isClosed: () => closed,
      isBuffering: () => buffering,
      setRegisteredRemoteDesktopDriver: () => {
        registeredRemoteDesktopDriver = true
      },
      setPendingRemoteDesktopViewport: (viewport) => {
        pendingRemoteDesktopViewport = viewport
      },
      getDesktopClaimTail: () => desktopClaimTail,
      setDesktopClaimTail: (tail) => {
        desktopClaimTail = tail
      },
      sendFrame
    }
  )
  const unsubscribeStreamData = runtime.subscribeToTerminalData(ptyId, (data, meta) => {
    if (closed) {
      return
    }
    if (buffering) {
      const rawLength = meta?.rawLength
      if (
        typeof meta?.seq === 'number' &&
        typeof rawLength === 'number' &&
        rawLength === data.length
      ) {
        const scan = scanTerminalReplyQuerySequences(
          data,
          meta.seq - rawLength,
          pendingQueryScanState
        )
        pendingQueryScanState = scan.state
        for (const query of scan.queries) {
          if (pendingQueryChars + query.data.length > TERMINAL_QUERY_REPLAY_MAX_CHARS) {
            pendingQueryOverflowed = true
            break
          }
          pendingQuerySequences.push(query)
          pendingQueryChars += query.data.length
        }
      } else {
        pendingQueryScanState = EMPTY_TERMINAL_REPLY_QUERY_SCAN_STATE
      }
      const remainingBudget = Math.max(1, TERMINAL_MULTIPLEX_PENDING_MAX_BYTES - pendingOutputBytes)
      const measurement = measureTerminalStreamByteLength(data, {
        stopAfterBytes: remainingBudget
      })
      pendingOutput.push({ data, bytes: measurement.byteLength, meta })
      pendingOutputBytes += measurement.byteLength
      const trimmed = trimPendingOutputToBudget(pendingOutput, pendingOutputBytes)
      pendingOutputBytes = trimmed.bytes
      pendingOutputOverflowed ||= trimmed.overflowed
      return
    }
    outputBatcher?.push(data, meta)
  })
  // Why: capture live bytes before mobile-fit awaits; registering presence first would suppress main while no view held the query.
  const releaseViewSubscriber = runtime.registerRemoteTerminalViewSubscriber(ptyId)
  unsubscribeData = () => {
    releaseViewSubscriber()
    unsubscribeStreamData()
  }
  const state: LegacyBinarySubscriptionState = {
    streamId,
    remoteDesktopSubscriptionKey,
    get closed() {
      return closed
    },
    set closed(value) {
      closed = value
    },
    get buffering() {
      return buffering
    },
    set buffering(value) {
      buffering = value
    },
    get pendingRemoteDesktopViewport() {
      return pendingRemoteDesktopViewport
    },
    set pendingRemoteDesktopViewport(value) {
      pendingRemoteDesktopViewport = value
    },
    get lastResizeCols() {
      return lastResizeCols
    },
    set lastResizeCols(value) {
      lastResizeCols = value
    },
    get resizeGeneration() {
      return resizeGeneration
    },
    set resizeGeneration(value) {
      resizeGeneration = value
    },
    get pendingOutput() {
      return pendingOutput
    },
    set pendingOutput(value) {
      pendingOutput = value
    },
    get pendingOutputBytes() {
      return pendingOutputBytes
    },
    set pendingOutputBytes(value) {
      pendingOutputBytes = value
    },
    get pendingOutputOverflowed() {
      return pendingOutputOverflowed
    },
    set pendingOutputOverflowed(value) {
      pendingOutputOverflowed = value
    },
    pendingQuerySequences,
    get pendingQueryOverflowed() {
      return pendingQueryOverflowed
    },
    set pendingQueryOverflowed(value) {
      pendingQueryOverflowed = value
    },
    get lateRendererReadyPromise() {
      return lateRendererReadyPromise
    },
    set lateRendererReadyPromise(value) {
      lateRendererReadyPromise = value
    },
    get abortRendererMountWait() {
      return abortRendererMountWait
    },
    set abortRendererMountWait(value) {
      abortRendererMountWait = value
    },
    outputBatcher: outputBatcher!,
    get unsubscribeResize() {
      return unsubscribeResize
    },
    set unsubscribeResize(value) {
      unsubscribeResize = value
    },
    get unsubscribeFit() {
      return unsubscribeFit
    },
    set unsubscribeFit(value) {
      unsubscribeFit = value
    },
    get registeredRemoteDesktopDriver() {
      return registeredRemoteDesktopDriver
    },
    set registeredRemoteDesktopDriver(value) {
      registeredRemoteDesktopDriver = value
    },
    displayMode: 'auto',
    registration,
    streamClosed,
    sendFrame
  }
  try {
    await publishLegacyBinaryInitialSnapshot(args, state)
    if (state.closed || signal?.aborted) {
      return
    }
    activateLegacyBinarySubscription(args, state)
  } catch (error) {
    registration.releaseIfCurrent()
    throw error
  }
  await streamClosed
}
