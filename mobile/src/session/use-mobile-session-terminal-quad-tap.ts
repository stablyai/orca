import { useCallback } from 'react'
import { clearTerminalLiveInputFocusTimer } from '../terminal/terminal-live-input'
import type { MobileSessionTerminalWebviewModel } from './use-mobile-session-terminal-webview'

type TerminalQuadTapHandlers = {
  readonly handleAccessoryKey: (key: { bytes: string }, handle?: string) => Promise<boolean>
}

export function useMobileSessionTerminalQuadTap(
  scope: MobileSessionTerminalWebviewModel,
  { handleAccessoryKey }: TerminalQuadTapHandlers
) {
  const {
    handleTerminalInteraction,
    liveInputFocusTimerRef,
    quadTapAltMEnabled,
    visibleTerminalHandlesRef
  } = scope

  return useCallback(
    async (handle: string) => {
      if (!quadTapAltMEnabled || !visibleTerminalHandlesRef.current.includes(handle)) {
        return
      }
      clearTerminalLiveInputFocusTimer(liveInputFocusTimerRef)
      handleTerminalInteraction(handle)
      await handleAccessoryKey({ bytes: '\u001bm' }, handle)
    },
    [
      handleAccessoryKey,
      handleTerminalInteraction,
      liveInputFocusTimerRef,
      quadTapAltMEnabled,
      visibleTerminalHandlesRef
    ]
  )
}
