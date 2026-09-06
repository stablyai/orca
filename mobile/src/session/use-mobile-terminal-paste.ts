import { useCallback, type RefObject } from 'react'
import { File as FsFile, Paths } from 'expo-file-system'
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator'
import type { TerminalModes } from '../terminal/terminal-webview-contract'
import { isTerminalSendRpcAccepted } from '../terminal/terminal-send-rpc-response'
import { TERMINAL_INPUT_SEND_OPTIONS } from '../terminal/terminal-send-request'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import {
  captureMobileTerminalClipboard,
  MOBILE_TERMINAL_PASTE_RESERVED_BYTES
} from './mobile-terminal-clipboard-snapshot'
import {
  buildMobileImagePastePayload,
  saveMobileClipboardImageAsTempFile,
  type MobileClipboardImageResizer
} from './mobile-clipboard-image'

const CLIPBOARD_IMAGE_DATA_URL_PREFIX_RE = /^data:image\/[a-z0-9.+-]+;base64,/i

// Why: clipboard images are re-encoded as lossless PNG, so high-res screenshots and
// photos can exceed the upload byte budget; resize the raster down to fit before upload.
// The iOS ImageManipulator loader cannot decode large base64 data URIs, so use a file.
const resizeMobileClipboardImage: MobileClipboardImageResizer = async (source, target) => {
  const base64 = source.replace(CLIPBOARD_IMAGE_DATA_URL_PREFIX_RE, '')
  const file = new FsFile(Paths.cache, `orca-clip-resize-${Date.now()}.png`)
  let context: ReturnType<typeof ImageManipulator.manipulate> | null = null
  let rendered: Awaited<
    ReturnType<ReturnType<typeof ImageManipulator.manipulate>['renderAsync']>
  > | null = null
  let resultUri: string | null = null
  try {
    file.create({ overwrite: true })
    file.write(base64, { encoding: 'base64' })
    context = ImageManipulator.manipulate(file.uri)
    context.resize({ width: target.width, height: target.height })
    rendered = await context.renderAsync()
    const result = await rendered.saveAsync({ format: SaveFormat.PNG, base64: true })
    resultUri = result.uri
    // Why: empty base64 would pass the downstream base64 check and upload a corrupt
    // image, so fail loudly here instead of silently sending an invalid payload.
    if (!result.base64) {
      throw new Error('Failed to encode resized clipboard image')
    }
    return { data: result.base64, width: result.width, height: result.height }
  } finally {
    rendered?.release()
    context?.release()
    if (resultUri) {
      try {
        new FsFile(resultUri).delete()
      } catch {
        // Best-effort cleanup; ImageManipulator saves into cache for every retry.
      }
    }
    try {
      file.delete()
    } catch {
      // Best-effort cleanup; the OS reclaims the cache directory regardless.
    }
  }
}

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
  readonly activeHandle: string | null
  readonly activeHandleRef: RefObject<string | null>
  readonly activeSessionTabTypeRef: RefObject<string | null>
  readonly canSend: boolean
  readonly client: RpcClient | null
  readonly clientRef: RefObject<RpcClient | null>
  readonly connState: ConnectionState
  readonly connStateRef: RefObject<ConnectionState>
  readonly deviceTokenRef: RefObject<string | null>
  readonly flushPendingLiveInputBeforeExternalSend: import('../terminal/terminal-live-input-sender').TerminalLiveExternalSend
  readonly getActiveWorktreeConnectionId: () => Promise<string | null>
  readonly onError: () => void
  readonly onSuccess: () => void
  readonly ptyModesRef: RefObject<Map<string, TerminalModes>>
  readonly refreshCanPaste: () => void
  readonly showToast: (message: string, durationMs?: number) => void
}

export function useMobileTerminalPaste({
  activeHandle,
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
}: UseMobileTerminalPasteOptions): (
  options?: Pick<
    import('../terminal/terminal-live-input-sender').TerminalLiveControlOptions,
    'fieldBoundary'
  >
) => Promise<void> {
  return useCallback(
    async (options) => {
      if (!client || !activeHandle || !canSend) {
        return
      }
      const targetHandle = activeHandle
      let clipboard: ReturnType<typeof captureMobileTerminalClipboard> | undefined
      const reportError = (e: unknown) => {
        onError()
        const err = e as { name?: string; message?: string }
        // eslint-disable-next-line no-console
        console.warn('[mobile-clip] paste failed', { name: err?.name, message: err?.message })
        showToast(
          connStateRef.current !== 'connected'
            ? 'Paste failed (disconnected)'
            : err?.message === 'Clipboard text is too large'
              ? 'Paste too large (max 256 KiB)'
              : err?.message === 'Clipboard image is too large'
                ? 'Image too large to paste'
                : 'Paste failed',
          1500
        )
      }
      // Reserve order before clipboard/image work can yield to a following key.
      const accepted = await flushPendingLiveInputBeforeExternalSend(
        targetHandle,
        async (isCurrent) => {
          const canPrepare = () =>
            isCurrent() &&
            clientRef.current === client &&
            connStateRef.current === 'connected' &&
            targetHandle === activeHandleRef.current &&
            activeSessionTabTypeRef.current === 'terminal'
          if (!canPrepare()) {
            return 'cancelled'
          }
          let dispatched = false
          try {
            const snapshot = await clipboard?.read()
            if (!canPrepare()) {
              return 'cancelled'
            }
            if (!snapshot) {
              return 'cancelled'
            }
            const { text, image } = snapshot
            let payload: string | null = null
            if (text.length > 0) {
              payload = buildMobileTerminalClipboardTextPayload(
                text,
                ptyModesRef.current.get(targetHandle)
              )
            } else {
              if (!image) {
                refreshCanPaste()
                return 'cancelled'
              }
              const connectionId = await getActiveWorktreeConnectionId()
              if (!canPrepare()) {
                return 'cancelled'
              }
              const imagePath = await saveMobileClipboardImageAsTempFile(client, image.data, {
                connectionId
              })
              if (!canPrepare()) {
                return 'cancelled'
              }
              payload = buildMobileImagePastePayload(imagePath)
            }

            const wrappedBytes = new TextEncoder().encode(payload).byteLength
            if (wrappedBytes > 256 * 1024) {
              onError()
              // eslint-disable-next-line no-console
              console.warn('[mobile-clip] paste oversized', { wrappedBytes })
              showToast('Paste too large (max 256 KiB)', 1500)
              return false
            }
            if (!canPrepare()) {
              return 'cancelled'
            }
            dispatched = true
            const response = await client.sendRequest(
              'terminal.send',
              {
                terminal: targetHandle,
                text: payload,
                enter: false,
                ...(deviceTokenRef.current
                  ? { client: { id: deviceTokenRef.current, type: 'mobile' as const } }
                  : {})
              },
              TERMINAL_INPUT_SEND_OPTIONS
            )
            return isTerminalSendRpcAccepted(response)
          } catch (e) {
            if (!dispatched && !canPrepare()) {
              return 'cancelled'
            }
            if (canPrepare()) {
              reportError(e)
            }
            return false
          }
        },
        '',
        {
          fieldBoundary: options?.fieldBoundary,
          reservedBytes: MOBILE_TERMINAL_PASTE_RESERVED_BYTES,
          onAdmitted: () => {
            clipboard = captureMobileTerminalClipboard(resizeMobileClipboardImage)
          }
        }
      ).finally(() => clipboard?.dispose())
      if (accepted) {
        onSuccess()
        refreshCanPaste()
      }
    },
    [
      activeHandle,
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
    ]
  )
}
