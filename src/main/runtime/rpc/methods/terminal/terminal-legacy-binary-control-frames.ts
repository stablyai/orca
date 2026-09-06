import {
  TerminalStreamOpcode,
  decodeTerminalStreamJson,
  encodeTerminalStreamJson,
  decodeTerminalStreamText
} from '../../../../../shared/terminal-stream-protocol'
import { isTerminalInputLockedForClient, sendTerminalStreamInput } from './terminal-input-delivery'
import type { TerminalSubscriptionArgs } from './terminal-legacy-subscription-types'
import { updateViewportForClient } from './terminal-viewport-update'
import {
  captureTerminalStreamInputTarget,
  runTerminalInputInArrivalOrder
} from '../../../terminal-input-arrival'
import { TerminalOrderedInputReceipts } from './terminal-ordered-input-receipts'
import { waitForPromiseWithSignal } from '../../../../../shared/abort-signal-reason'

type LegacyBinaryControlState = {
  isClosed: () => boolean
  signal?: AbortSignal
  close: () => void
  isBuffering: () => boolean
  setRegisteredRemoteDesktopDriver: () => void
  setPendingRemoteDesktopViewport: (viewport: { cols: number; rows: number }) => void
  getDesktopClaimTail: () => Promise<boolean>
  setDesktopClaimTail: (tail: Promise<boolean>) => void
  sendFrame: (opcode: TerminalStreamOpcode, payload?: Uint8Array<ArrayBufferLike>) => void
}

export function registerLegacyBinaryControlFrames(
  args: TerminalSubscriptionArgs,
  streamId: number,
  remoteDesktopSubscriptionKey: string,
  controls: LegacyBinaryControlState
): () => void {
  const {
    params,
    runtime,
    registerBinaryStreamHandler,
    ptyId,
    clientId,
    isMobile,
    supportsDesktopViewportClaims,
    supportsWriteUnavailable
  } = args
  if (!registerBinaryStreamHandler) {
    return () => {}
  }
  const inputTarget = captureTerminalStreamInputTarget(runtime, params.terminal, ptyId)
  const orderedInput = args.supportsOrderedInput
    ? new TerminalOrderedInputReceipts({
        isClosed: controls.isClosed,
        close: controls.close,
        receipt: (inputReceipt) =>
          controls.sendFrame(
            TerminalStreamOpcode.Metadata,
            encodeTerminalStreamJson({ inputReceipt })
          ),
        enqueue: (retainedCodeUnits, run) =>
          runTerminalInputInArrivalOrder(
            runtime,
            params.terminal,
            retainedCodeUnits,
            controls.signal,
            run,
            inputTarget
          ),
        write: async (text) => {
          const claimed = await waitForPromiseWithSignal(
            controls.getDesktopClaimTail(),
            controls.signal
          )
          if (
            !claimed ||
            controls.isClosed() ||
            isTerminalInputLockedForClient(runtime, ptyId, params.client)
          ) {
            return { outcome: 'rejected', reason: 'not_writable' }
          }
          let attempted = false
          const outcome = await sendTerminalStreamInput(runtime, {
            terminal: params.terminal,
            text,
            client: params.client,
            isMobile,
            onWriteAttempt: () => {
              attempted = true
            }
          })
          if (outcome === 'delivered') {
            return { outcome: 'accepted' }
          }
          return attempted
            ? { outcome: 'unknown', reason: 'write_failed' }
            : { outcome: 'rejected', reason: 'not_writable' }
        }
      })
    : null
  return registerBinaryStreamHandler(streamId, (frame) => {
    if (controls.isClosed()) {
      return
    }
    if (frame.opcode === TerminalStreamOpcode.Input) {
      if (orderedInput) {
        orderedInput.receive(frame.seq, frame.payload)
        return
      }
      const text = decodeTerminalStreamText(frame.payload)
      if (!text) {
        return
      }
      if (isTerminalInputLockedForClient(runtime, ptyId, params.client)) {
        return
      }
      void runTerminalInputInArrivalOrder(
        runtime,
        params.terminal,
        text.length,
        controls.signal,
        async () => {
          const claimed = await waitForPromiseWithSignal(
            controls.getDesktopClaimTail(),
            controls.signal
          )
          if (controls.isClosed()) {
            return
          }
          if (!claimed || isTerminalInputLockedForClient(runtime, ptyId, params.client)) {
            return
          }
          const outcome = await sendTerminalStreamInput(runtime, {
            terminal: params.terminal,
            text,
            client: params.client,
            isMobile
          })
          if (!controls.isClosed() && outcome === 'rejected' && supportsWriteUnavailable) {
            controls.sendFrame(TerminalStreamOpcode.WriteUnavailable)
          }
        },
        inputTarget
      ).catch(() => {
        if (!controls.isClosed() && supportsWriteUnavailable) {
          controls.sendFrame(TerminalStreamOpcode.WriteUnavailable)
        }
      })
      return
    }
    if (frame.opcode === TerminalStreamOpcode.Resize && params.client) {
      const viewport = decodeTerminalStreamJson<{ cols?: unknown; rows?: unknown }>(frame.payload)
      if (!viewport || typeof viewport.cols !== 'number' || typeof viewport.rows !== 'number') {
        return
      }
      const cols = viewport.cols
      const rows = viewport.rows
      if (clientId) {
        controls.setRegisteredRemoteDesktopDriver()
        if (controls.isBuffering()) {
          controls.setPendingRemoteDesktopViewport({ cols: viewport.cols, rows: viewport.rows })
          return
        }
      }
      controls.setDesktopClaimTail(
        controls
          .getDesktopClaimTail()
          .then(async (priorClaimed) => {
            const result = await updateViewportForClient(
              runtime,
              ptyId,
              remoteDesktopSubscriptionKey,
              params.client!,
              { cols, rows },
              'desktop',
              'register',
              !supportsDesktopViewportClaims
            )
            return supportsDesktopViewportClaims ? priorClaimed && result.applied : result.applied
          })
          .catch(() => false)
      )
      return
    }
    if (
      frame.opcode === TerminalStreamOpcode.ClaimViewport &&
      params.client &&
      clientId &&
      !isMobile
    ) {
      const viewport = decodeTerminalStreamJson<{ cols?: unknown; rows?: unknown }>(frame.payload)
      if (!viewport || typeof viewport.cols !== 'number' || typeof viewport.rows !== 'number') {
        return
      }
      const cols = viewport.cols
      const rows = viewport.rows
      controls.setRegisteredRemoteDesktopDriver()
      controls.setDesktopClaimTail(
        controls
          .getDesktopClaimTail()
          .then(
            () =>
              runtime.updateRemoteDesktopViewer(
                ptyId,
                remoteDesktopSubscriptionKey,
                clientId,
                cols,
                rows,
                true
              ),
            () =>
              runtime.updateRemoteDesktopViewer(
                ptyId,
                remoteDesktopSubscriptionKey,
                clientId,
                cols,
                rows,
                true
              )
          )
          .catch(() => false)
      )
    }
  })
}
