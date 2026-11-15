import {
  TerminalStreamOpcode,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson
} from '../../../../../shared/terminal/stream/terminal-stream-protocol'
import type { TerminalOutputMeta } from '../../terminal/terminal-output-frame-chunks'
import { iterateStreamOutputFrames } from './terminal-stream-resume-ledger'
import {
  EMPTY_TERMINAL_REPLY_QUERY_SCAN_STATE,
  scanTerminalReplyQuerySequences,
  type TerminalReplyQueryScanState,
  type TerminalReplyQuerySequence
} from '../../../../../shared/terminal/protocol/queries/terminal-reply-query-scan'
import { TERMINAL_MULTIPLEX_PENDING_MAX_BYTES } from '../../../../../shared/terminal/stream/terminal-multiplex-flow-control'
import { measureTerminalStreamByteLength } from '../../terminal/terminal-stream-byte-length'
import { createTerminalOutputBatcher, type TerminalOutputBatcher } from './terminal-output-batcher'
import { trimPendingOutputToBudget } from './terminal-stream-replay'
import { allocateTerminalSubscriptionStreamId } from './terminal-subscription-stream-id'
import type {
  TerminalSubscribeBinaryState,
  TerminalSubscriptionArgs
} from './terminal-subscribe-types'
import type { TerminalOutputChunk } from './terminal-stream-types'
import { publishTerminalSubscribeBinarySnapshot } from './terminal-subscribe-binary-snapshot'
import { sendTerminalCreditRecoverySnapshot } from './terminal-subscribe-recovery-snapshot'
import { activateTerminalSubscribeBinaryLive } from './terminal-subscribe-binary-live'
import { registerTerminalSubscribeBinaryControlFrames } from './terminal-subscribe-binary-control-frames'
import {
  createTerminalOutputCredit,
  TERMINAL_QUERY_REPLAY_MAX_CHARS,
  type TerminalOutputCredit
} from './terminal-output-credit'
import { registerTerminalStreamToken } from './terminal-stream-tokens'
export async function runTerminalBinarySubscription(args: TerminalSubscriptionArgs): Promise<void> {
  const { runtime, registration, sendBinary, ptyId, clientId, viewerDeviceId, isMobile } = args
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
  let lateRendererReadyPromise: Promise<boolean> | null = null
  let outputBatcher: TerminalOutputBatcher | null = null
  let outputCredit: TerminalOutputCredit | null = null
  let streamToken: ReturnType<typeof registerTerminalStreamToken> | null = null
  let resolveStream = (): void => {}
  const streamClosed = new Promise<void>((resolve) => {
    resolveStream = resolve
  })
  registration.setTeardown((release) => {
    outputCredit?.close(release)
    outputBatcher?.flush()
    outputCredit?.dispose()
    outputBatcher?.dispose()
    streamToken?.release()
    closed = true
    unsubscribeData()
    unsubscribeResize()
    unsubscribeFit()
    unregisterBinaryHandler()
    abortRendererMountWait()
    // Registration owns phone presence; only desktop viewers take width floors here.
    if (!isMobile && registeredRemoteDesktopDriver && clientId) {
      runtime.unregisterRemoteDesktopViewer(ptyId, remoteDesktopSubscriptionKey)
    }
    resolveStream()
  })
  if (registration.released) {
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
    streamToken?.ledger?.noteSentFrame(opcode)
    sendBinary(encodeTerminalStreamFrame({ opcode, streamId, seq: frameSeq, payload }), {
      compressible: true
    })
  }
  const sendOutputFrames = (data: string, meta?: TerminalOutputMeta): void => {
    // Why text: phones before this release can't decode OutputSpan, so a span here is output they drop.
    for (const chunk of iterateStreamOutputFrames(streamToken?.ledger, data, meta)) {
      sendFrame(chunk.opcode ?? TerminalStreamOpcode.Output, chunk.bytes, chunk.seq)
    }
  }
  // Only clients that ask get credit; others, and hosts before it, stream uncredited.
  if (args.params.capabilities?.outputAck === 1) {
    outputCredit = createTerminalOutputCredit({
      send: sendOutputFrames,
      sendRecoverySnapshot: () => sendTerminalCreditRecoverySnapshot(args, state)
    })
    streamToken = registerTerminalStreamToken(args, outputCredit.acknowledge)
  }
  outputBatcher = createTerminalOutputBatcher((data, meta) => {
    // Metadata bypasses credit so dropped output never loses a cwd change.
    if (meta?.cwd !== undefined) {
      sendFrame(
        TerminalStreamOpcode.Metadata,
        encodeTerminalStreamJson({ cwd: meta.cwd }),
        meta.seq
      )
    }
    if (outputCredit) {
      outputCredit.deliver(data, meta)
    } else {
      sendOutputFrames(data, meta)
    }
  })
  unregisterBinaryHandler = registerTerminalSubscribeBinaryControlFrames(
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
  // Capture live bytes before fit awaits; early presence would suppress main before any view could answer queries.
  const releaseViewSubscriber = runtime.registerRemoteTerminalViewSubscriber(
    ptyId,
    undefined,
    isMobile ? clientId : undefined,
    false,
    viewerDeviceId
  )
  unsubscribeData = () => {
    releaseViewSubscriber()
    unsubscribeStreamData()
  }
  const state: TerminalSubscribeBinaryState = {
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
    streamClosed,
    sendFrame
  }
  await publishTerminalSubscribeBinarySnapshot(args, state, streamToken)
  if (registration.released) {
    return
  }
  args.onEstablished?.()
  activateTerminalSubscribeBinaryLive(args, state, outputCredit)
  await streamClosed
}
