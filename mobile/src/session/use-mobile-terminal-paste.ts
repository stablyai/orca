import { separateImagePasteFromFollowingText } from '../../../src/shared/image-paste-following-text'
import {
  normalizeTerminalPasteLineEndings,
  wrapTerminalBracketedPasteText
} from '../../../src/shared/terminal-bracketed-paste-text'
import { reportWorkerTerminalUserInput } from '../terminal/worker-terminal-takeover-report'
import { useCallback, type RefObject } from 'react'
import { terminalInputSend } from '../terminal/mobile-terminal-operations'
import { useClipboardReader } from '../platform/clipboard'
import type { TerminalModes } from '../terminal/terminal-webview-contract'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import {
  buildMobileTerminalImagePastePayload,
  prepareMobileClipboardImageBase64,
  saveMobileClipboardImageAsTempFile
} from './mobile-clipboard-image'
import { resizeMobileClipboardImage } from './mobile-clipboard-image-resize'

// Match xterm's paste(): newlines become CR, and DECSET 2004 frames the text with ESC made inert.
function buildMobileTerminalClipboardTextPayload(
  text: string,
  modes: TerminalModes | undefined
): string {
  return modes?.bracketedPasteMode === true
    ? wrapTerminalBracketedPasteText(text)
    : normalizeTerminalPasteLineEndings(text)
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
  // Read images through native media handles: inline clipboard base64 can exceed the bridge reply cap.
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
          // Null also covers iOS paste denial and undecodable images.
          onError()
          showToast("Couldn't read the clipboard", 1500)
          refreshCanPaste()
          return
        }
        const connectionId = await getActiveWorktreeConnectionId()
        const base64 = await prepareMobileClipboardImageBase64(image, resizeMobileClipboardImage)
        const imagePath = await saveMobileClipboardImageAsTempFile(client, base64, {
          connectionId
        })
        payload = separateImagePasteFromFollowingText(
          buildMobileTerminalImagePastePayload(imagePath, agent),
          true
        )
      }

      const wrappedBytes = new TextEncoder().encode(payload).byteLength
      if (wrappedBytes > 256 * 1024) {
        onError()
        console.warn('[mobile-clip] paste oversized', { wrappedBytes })
        showToast('Paste too large (max 256 KiB)', 1500)
        return
      }
      // Accessory paste must follow pending IME text.
      const flushedPendingInput = await flushPendingLiveInputBeforeExternalSend(targetHandle)
      const currentClient = clientRef.current
      if (!currentClient || connStateRef.current !== 'connected') {
        onError()
        showToast('Paste failed (disconnected)', 1500)
        return
      }
      if (
        targetHandle !== activeHandleRef.current ||
        activeSessionTabTypeRef.current !== 'terminal'
      ) {
        onError()
        showToast('Paste canceled (terminal changed)', 1500)
        return
      }
      if (!flushedPendingInput) {
        onError()
        showToast('Paste failed', 1500)
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
