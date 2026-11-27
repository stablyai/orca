import { separateImagePasteFromFollowingText } from '../../../../../src/shared/terminal/input/image-paste-following-text'
import {
  BRACKETED_PASTE_END,
  normalizeTerminalPasteLineEndings,
  wrapTerminalBracketedPasteText
} from '../../../../../src/shared/terminal/input/terminal-bracketed-paste-text'
import {
  isTerminalInputTooLargeWithYield,
  splitTerminalInputChunks
} from '../../../../../src/shared/terminal/input/terminal-input'
import { epoch } from '../../input-delivery/mobile-terminal-input-owner'
import { useCallback, useRef, type RefObject } from 'react'
import { translate } from '../../../i18n/mobile-i18n'
import { terminalInputSend } from '../../host-operations/mobile-terminal-operations'
import { useClipboardReader } from '../../../platform/clipboard/clipboard'
import type { TerminalModes } from '../../webview/terminal-webview-contract'
import type { RpcClient } from '../../../transport/rpc/rpc-client-contract'
import type { ConnectionState } from '../../../transport/connection/connection-state'
import {
  buildMobileTerminalImagePastePayload,
  saveMobileClipboardImageAsTempFile
} from '../../../files/attachments/mobile-clipboard-image'
import { fitMobileAgentImageBase64 } from '../../../files/attachments/mobile-agent-image-fit'

// JSON escapes a control character to 6 bytes; 64 KiB chunks stay inside the page bridge frame and the host's 1 MiB frame.
const PASTE_SEND_CHUNK_BYTES = 64 * 1024

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
  readonly sendTerminalUserInput: typeof terminalInputSend.request
  readonly agent?: string | null
  readonly activeHandle: string | null
  readonly activeHandleRef: RefObject<string | null>
  readonly activeSessionTabTypeRef: RefObject<string | null>
  readonly canSend: boolean
  readonly client: RpcClient | null
  readonly clientRef: RefObject<RpcClient | null>
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
  sendTerminalUserInput,
  activeHandle,
  agent,
  activeHandleRef,
  activeSessionTabTypeRef,
  canSend,
  client,
  clientRef,
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
  // One paste at a time owns the terminal's input, so another paste or its held-text flush cannot land inside it.
  const pasteRunningRef = useRef(false)
  return useCallback(async () => {
    if (!client || !activeHandle || !canSend) {
      return
    }
    if (pasteRunningRef.current) {
      onError()
      showToast(translate('session.useTerminalPaste.pasteFailed', 'Paste failed'), 1500)
      return
    }
    pasteRunningRef.current = true
    const targetHandle = activeHandle
    try {
      const text = await clipboard.readText()
      let payload: string | null = null
      let bracketed = false
      if (text.length > 0) {
        const modes = ptyModesRef.current.get(targetHandle)
        bracketed = modes?.bracketedPasteMode === true
        payload = buildMobileTerminalClipboardTextPayload(text, modes)
      } else {
        const image = await clipboard.readImage()
        if (!image) {
          // Null also covers iOS paste denial and undecodable images.
          onError()
          showToast(
            translate(
              'session.useTerminalPaste.clipboardReadFailed',
              "Couldn't read the clipboard"
            ),
            1500
          )
          refreshCanPaste()
          return
        }
        const connectionId = await getActiveWorktreeConnectionId()
        const base64 = await fitMobileAgentImageBase64(image.data)
        const imagePath = await saveMobileClipboardImageAsTempFile(client, base64, {
          connectionId
        })
        payload = separateImagePasteFromFollowingText(
          buildMobileTerminalImagePastePayload(imagePath, agent),
          true
        )
      }

      if (await isTerminalInputTooLargeWithYield(payload)) {
        onError()
        console.warn('[mobile-clip] paste oversized', { length: payload.length })
        showToast(translate('session.useTerminalPaste.pasteTooLarge', 'Paste is too large.'), 1500)
        return
      }
      // Accessory paste must follow pending IME text.
      const flushedPendingInput = await flushPendingLiveInputBeforeExternalSend(targetHandle)
      const currentClient = clientRef.current
      if (!currentClient || connStateRef.current !== 'connected') {
        onError()
        showToast(
          translate('session.useTerminalPaste.disconnected', 'Paste failed (disconnected)'),
          1500
        )
        return
      }
      if (
        targetHandle !== activeHandleRef.current ||
        activeSessionTabTypeRef.current !== 'terminal'
      ) {
        onError()
        showToast(
          translate(
            'session.useTerminalPaste.terminalChanged',
            'Paste canceled (terminal changed)'
          ),
          1500
        )
        return
      }
      if (!flushedPendingInput) {
        onError()
        showToast(translate('session.useTerminalPaste.pasteFailed', 'Paste failed'), 1500)
        return
      }
      const sendChunk = (text: string) =>
        sendTerminalUserInput(currentClient, {
          terminal: targetHandle,
          text,
          enter: false,
          ...(deviceTokenRef.current
            ? { client: { id: deviceTokenRef.current, type: 'mobile' as const } }
            : {})
        }).then(
          (response) => terminalInputSend.interpret(response) === true,
          () => false
        )
      let delivered = true
      // Send in order and stop at the first refusal or reconnect, as desktop's remote paste does.
      const pasteEpoch = epoch(currentClient)
      for (const [index, chunk] of splitTerminalInputChunks(
        payload,
        PASTE_SEND_CHUNK_BYTES
      ).entries()) {
        if (epoch(currentClient) !== pasteEpoch) {
          delivered = false
          break
        }
        if (!(await sendChunk(chunk))) {
          // Close a bracketed paste whose start landed so the program leaves paste mode.
          if (index > 0 && bracketed) {
            await sendChunk(BRACKETED_PASTE_END)
          }
          delivered = false
          break
        }
      }
      if (!delivered) {
        throw new Error('Terminal input was not accepted')
      }
      onSuccess()
      refreshCanPaste()
    } catch (e) {
      onError()
      const err = e as { name?: string; message?: string }
      const isDisconnected = connStateRef.current !== 'connected'
      console.warn('[mobile-clip] paste failed', { name: err.name, message: err.message })
      if (isDisconnected) {
        showToast(
          translate('session.useTerminalPaste.disconnected', 'Paste failed (disconnected)'),
          1500
        )
      } else if (e instanceof Error && 'reason' in e && e.reason === 'reply-too-large') {
        // The page's clipboard bridge caps one reply below desktop's paste limit.
        showToast(translate('session.useTerminalPaste.pasteTooLarge', 'Paste is too large.'), 1500)
      } else if (err.message === 'Clipboard image is too large') {
        showToast(
          translate('session.useTerminalPaste.imageTooLarge', 'Image too large to paste'),
          1500
        )
      } else {
        showToast(translate('session.useTerminalPaste.pasteFailed', 'Paste failed'), 1500)
      }
    } finally {
      pasteRunningRef.current = false
    }
  }, [
    sendTerminalUserInput,
    activeHandle,
    agent,
    activeHandleRef,
    activeSessionTabTypeRef,
    canSend,
    client,
    clientRef,
    clipboard,
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
