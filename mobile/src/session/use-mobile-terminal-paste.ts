import { separateImagePasteFromFollowingText } from '../../../src/shared/image-paste-following-text'
import { reportWorkerTerminalUserInput } from '../terminal/worker-terminal-takeover-report'
import { useCallback, type RefObject } from 'react'
import { terminalInputSend } from '../terminal/mobile-terminal-operations'
import { useClipboardReader } from '../platform/clipboard'
import type { TerminalModes } from '../terminal/terminal-webview-contract'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import {
  buildMobileImagePastePayload,
  prepareMobileClipboardImageBase64,
  saveMobileClipboardImageAsTempFile
} from './mobile-clipboard-image'
import { resizeMobileClipboardImage } from './mobile-clipboard-image-resize'

function buildMobileTerminalClipboardTextPayload(
  text: string,
  modes: TerminalModes | undefined
): string {
  const wrap = modes?.bracketedPasteMode === true && !modes.altScreen
  // Why: strip embedded bracketed-paste markers so copied text cannot terminate
  // paste mode early and turn trailing bytes into shell commands.
  // eslint-disable-next-line no-control-regex -- intentional bracketed-paste marker stripping
  const sanitized = wrap ? text.replace(/\x1b\[20[01]~/g, '') : text
  return wrap ? `\x1b[200~${sanitized}\x1b[201~` : sanitized
}

type UseMobileTerminalPasteOptions = {
  readonly agent?: string | null
  readonly activeHandle: string | null
  readonly activeHandleRef: RefObject<string | null>
  readonly activeSessionTabTypeRef: RefObject<string | null>
  readonly canSend: boolean
  readonly client: RpcClient | null
  readonly clientRef: RefObject<RpcClient | null>
  readonly connState: ConnectionState
  readonly connStateRef: RefObject<ConnectionState>
  readonly deviceTokenRef: RefObject<string | null>
  readonly flushPendingLiveInputBeforeExternalSend: (handle: string) => Promise<boolean>
  readonly getActiveWorktreeConnectionId: () => Promise<string | null>
  readonly onError: () => void
  readonly onSuccess: () => void
  readonly ptyModesRef: RefObject<Map<string, TerminalModes>>
  readonly refreshCanPaste: () => void
  readonly showToast: (message: string, durationMs?: number) => void
}

export function useMobileTerminalPaste({
  activeHandle,
  agent,
  activeHandleRef,
  activeSessionTabTypeRef,
  canSend,
  client,
  clientRef,
  connState,
  connStateRef,
  deviceTokenRef,
  flushPendingLiveInputBeforeExternalSend,
  getActiveWorktreeConnectionId,
  onError,
  onSuccess,
  ptyModesRef,
  refreshCanPaste,
  showToast
}: UseMobileTerminalPasteOptions): () => Promise<void> {
  // The pasteboard through the seam, both halves: text is `native.clipboard.read` on the page and
  // an image is `native.media.pick { source: 'clipboard' }`, never an inline value, because a
  // clipboard image reaches 24 MiB of base64 against an 8 MiB reply ceiling.
  const clipboard = useClipboardReader()
  return useCallback(async () => {
    if (!client || !activeHandle || !canSend) {
      return
    }
    const targetHandle = activeHandle
    try {
      const text = await clipboard.readText()
      let payload: string | null = null
      if (text.length > 0) {
        payload = buildMobileTerminalClipboardTextPayload(
          text,
          ptyModesRef.current.get(targetHandle)
        )
      } else {
        const image = await clipboard.readImage()
        if (!image) {
          refreshCanPaste()
          return
        }
        const connectionId = await getActiveWorktreeConnectionId()
        const base64 = await prepareMobileClipboardImageBase64(image, resizeMobileClipboardImage)
        const imagePath = await saveMobileClipboardImageAsTempFile(client, base64, {
          connectionId
        })
        payload = separateImagePasteFromFollowingText(
          buildMobileImagePastePayload(imagePath, agent),
          true
        )
      }

      const wrappedBytes = new TextEncoder().encode(payload).byteLength
      if (wrappedBytes > 256 * 1024) {
        onError()
        // eslint-disable-next-line no-console
        console.warn('[mobile-clip] paste oversized', { wrappedBytes })
        showToast('Paste too large (max 256 KiB)', 1500)
        return
      }
      // Why: paste lives in the accessory row and must not overtake pending IME text.
      const flushedPendingInput = await flushPendingLiveInputBeforeExternalSend(targetHandle)
      if (!flushedPendingInput) {
        return
      }
      const currentClient = clientRef.current
      if (
        !currentClient ||
        connStateRef.current !== 'connected' ||
        targetHandle !== activeHandleRef.current ||
        activeSessionTabTypeRef.current !== 'terminal'
      ) {
        return
      }
      const response = await terminalInputSend.request(currentClient, {
        terminal: targetHandle,
        text: payload,
        enter: false,
        ...(deviceTokenRef.current
          ? { client: { id: deviceTokenRef.current, type: 'mobile' as const } }
          : {})
      })
      if (terminalInputSend.interpret(response) === true) {
        reportWorkerTerminalUserInput(currentClient, targetHandle)
      }
      onSuccess()
      refreshCanPaste()
    } catch (e) {
      onError()
      const err = e as { name?: string; message?: string }
      const isDisconnected = connState !== 'connected'
      // eslint-disable-next-line no-console
      console.warn('[mobile-clip] paste failed', { name: err.name, message: err.message })
      if (isDisconnected) {
        showToast('Paste failed (disconnected)', 1500)
      } else if (err.message === 'Clipboard image is too large') {
        showToast('Image too large to paste', 1500)
      } else {
        showToast('Paste failed', 1500)
      }
    }
  }, [
    activeHandle,
    agent,
    activeHandleRef,
    activeSessionTabTypeRef,
    canSend,
    client,
    clientRef,
    clipboard,
    connState,
    connStateRef,
    deviceTokenRef,
    flushPendingLiveInputBeforeExternalSend,
    getActiveWorktreeConnectionId,
    onError,
    onSuccess,
    ptyModesRef,
    refreshCanPaste,
    showToast
  ])
}
