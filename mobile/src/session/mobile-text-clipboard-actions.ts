import { useCallback } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import {
  assertMobileClipboardTextWithinLimit,
  buildTerminalTextPastePayload,
  readHostClipboardText,
  writeHostClipboardText
} from './mobile-clipboard-text'

type CurrentRef<T> = {
  readonly current: T
}

type TerminalPasteModes = {
  readonly altScreen?: boolean
  readonly bracketedPasteMode?: boolean
}

type ShowToast = (message: string, durationMs?: number) => void

type UseMobileTextClipboardActionsArgs = {
  readonly client: RpcClient | null
  readonly activeHandle: string | null
  readonly canSend: boolean
  readonly connState: ConnectionState
  readonly ptyModesRef: CurrentRef<Map<string, TerminalPasteModes>>
  readonly deviceTokenRef: CurrentRef<string | null>
  readonly readPhoneClipboardText: () => Promise<string>
  readonly refreshCanPaste: () => void
  readonly showToast: ShowToast
  readonly onPasteSuccess: () => void
  readonly onCopySuccess: () => void
  readonly onError: () => void
}

type ClipboardFailureToastCopy = {
  readonly disconnected: string
  readonly fallback: string
  readonly oversized: string
  readonly permissionDenied: string
}

type MobileTextClipboardActions = {
  readonly handlePasteFromDesktop: () => Promise<void>
  readonly handleCopyPhoneClipboardToDesktop: () => Promise<void>
}

function shouldWrapPaste(modes: TerminalPasteModes | undefined): boolean {
  return Boolean(modes?.bracketedPasteMode && !modes.altScreen)
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isPermissionError(error: unknown): boolean {
  return /permission|denied|not authorized/i.test(getErrorMessage(error))
}

function showClipboardFailureToast(
  error: unknown,
  connState: ConnectionState,
  showToast: ShowToast,
  copy: ClipboardFailureToastCopy
): void {
  if (connState !== 'connected') {
    showToast(copy.disconnected, 1500)
    return
  }
  const message = getErrorMessage(error)
  if (message === 'Clipboard text is too large') {
    showToast(copy.oversized, 1500)
    return
  }
  if (message.startsWith('Unknown method: clipboard.')) {
    showToast('Desktop update required for clipboard', 1600)
    return
  }
  if (isPermissionError(error)) {
    showToast(copy.permissionDenied, 1500)
    return
  }
  showToast(copy.fallback, 1500)
}

export function useMobileTextClipboardActions({
  client,
  activeHandle,
  canSend,
  connState,
  ptyModesRef,
  deviceTokenRef,
  readPhoneClipboardText,
  refreshCanPaste,
  showToast,
  onPasteSuccess,
  onCopySuccess,
  onError
}: UseMobileTextClipboardActionsArgs): MobileTextClipboardActions {
  const handlePasteFromDesktop = useCallback(async (): Promise<void> => {
    if (!client || !activeHandle || !canSend) {
      return
    }
    try {
      const text = await readHostClipboardText(client)
      if (text.length === 0) {
        onError()
        showToast('Desktop clipboard is empty', 1500)
        return
      }
      const payload = buildTerminalTextPastePayload(
        text,
        shouldWrapPaste(ptyModesRef.current.get(activeHandle))
      )
      await client.sendRequest('terminal.send', {
        terminal: activeHandle,
        text: payload,
        enter: false,
        ...(deviceTokenRef.current
          ? { client: { id: deviceTokenRef.current, type: 'mobile' as const } }
          : {})
      })
      onPasteSuccess()
    } catch (error) {
      onError()
      showClipboardFailureToast(error, connState, showToast, {
        disconnected: 'Desktop paste failed (disconnected)',
        fallback: 'Desktop paste failed',
        oversized: 'Desktop clipboard too large (max 256 KiB)',
        permissionDenied: 'Desktop clipboard permission denied'
      })
    }
  }, [
    activeHandle,
    canSend,
    client,
    connState,
    deviceTokenRef,
    onError,
    onPasteSuccess,
    ptyModesRef,
    showToast
  ])

  const handleCopyPhoneClipboardToDesktop = useCallback(async (): Promise<void> => {
    if (!client || !canSend) {
      return
    }
    try {
      const text = await readPhoneClipboardText()
      if (text.length === 0) {
        onError()
        showToast('Phone clipboard is empty', 1500)
        return
      }
      assertMobileClipboardTextWithinLimit(text)
      await writeHostClipboardText(client, text)
      onCopySuccess()
      refreshCanPaste()
      showToast('Copied to desktop', 1200)
    } catch (error) {
      onError()
      showClipboardFailureToast(error, connState, showToast, {
        disconnected: 'Copy to desktop failed (disconnected)',
        fallback: 'Copy to desktop failed',
        oversized: 'Phone clipboard too large (max 256 KiB)',
        permissionDenied: 'Phone clipboard permission denied'
      })
    }
  }, [
    canSend,
    client,
    connState,
    onCopySuccess,
    onError,
    readPhoneClipboardText,
    refreshCanPaste,
    showToast
  ])

  return { handlePasteFromDesktop, handleCopyPhoneClipboardToDesktop }
}
