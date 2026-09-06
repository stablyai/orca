import { useCallback, type RefObject } from 'react'
import type { TerminalModes } from '../terminal/terminal-webview-contract'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import { defaultMobileTerminalPastePayload } from './default-mobile-terminal-paste-payload'
import type { HostSessionTerminalOperations } from './host-session-terminal-operations'

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
  readonly flushPendingLiveInputBeforeExternalSend: (handle: string) => Promise<boolean>
  readonly getActiveWorktreeConnectionId: () => Promise<string | null>
  readonly onError: () => void
  readonly onSuccess: () => void
  readonly ptyModesRef: RefObject<Map<string, TerminalModes>>
  readonly refreshCanPaste: () => void
  readonly showToast: (message: string, durationMs?: number) => void
  readonly terminalOperations: HostSessionTerminalOperations | null
}

export function useMobileTerminalPaste({
  activeHandle,
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
  showToast,
  terminalOperations
}: UseMobileTerminalPasteOptions): () => Promise<void> {
  return useCallback(async () => {
    if (!activeHandle || !canSend) {
      return
    }
    const targetHandle = activeHandle
    try {
      if (!client) {
        if (!terminalOperations?.pasteClipboard) {
          return
        }
        const flushedPendingInput = await flushPendingLiveInputBeforeExternalSend(targetHandle)
        if (
          !flushedPendingInput ||
          connStateRef.current !== 'connected' ||
          targetHandle !== activeHandleRef.current ||
          activeSessionTabTypeRef.current !== 'terminal'
        ) {
          return
        }
        const modes = ptyModesRef.current.get(targetHandle)
        const result = await terminalOperations.pasteClipboard(
          targetHandle,
          modes?.bracketedPasteMode === true && !modes.altScreen
        )
        if (result?.status === 'accepted') {
          onSuccess()
          refreshCanPaste()
        } else if (result?.status === 'empty') {
          refreshCanPaste()
        } else if (result?.status === 'too-large') {
          onError()
          showToast('Image too large to paste', 1500)
        }
        return
      }
      const payload = await defaultMobileTerminalPastePayload({
        client,
        connectionId: getActiveWorktreeConnectionId,
        modes: ptyModesRef.current.get(targetHandle)
      })
      if (!payload) {
        refreshCanPaste()
        return
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
      await currentClient.sendRequest('terminal.send', {
        terminal: targetHandle,
        text: payload,
        enter: false,
        ...(deviceTokenRef.current
          ? { client: { id: deviceTokenRef.current, type: 'mobile' as const } }
          : {})
      })
      onSuccess()
      refreshCanPaste()
    } catch (e) {
      onError()
      const err = e as { name?: string; message?: string }
      const isDisconnected = connState !== 'connected'
      // eslint-disable-next-line no-console
      console.warn('[mobile-clip] paste failed', {
        kind: isDisconnected
          ? 'disconnected'
          : err.message === 'Clipboard image is too large'
            ? 'image-too-large'
            : 'unknown'
      })
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
    showToast,
    terminalOperations
  ])
}
