import {
  TerminalStreamOpcode,
  decodeTerminalStreamJson,
  decodeTerminalStreamText
} from '../../../../../shared/terminal-stream-protocol'
import { isTerminalInputLockedForClient, sendTerminalStreamInput } from './terminal-input-delivery'
import type { TerminalSubscriptionArgs } from './terminal-legacy-subscription-types'
import { updateViewportForClient } from './terminal-viewport-update'

type LegacyBinaryControlState = {
  isClosed: () => boolean
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
  return registerBinaryStreamHandler(streamId, (frame) => {
    if (controls.isClosed()) {
      return
    }
    if (frame.opcode === TerminalStreamOpcode.Input) {
      const text = decodeTerminalStreamText(frame.payload)
      if (!text) {
        return
      }
      if (isTerminalInputLockedForClient(runtime, ptyId, params.client)) {
        return
      }
      void controls.getDesktopClaimTail().then(async (claimed) => {
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
