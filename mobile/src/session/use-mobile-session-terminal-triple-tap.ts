import { useCallback } from 'react'
import { clearTerminalLiveInputFocusTimer } from '../terminal/terminal-live-input'
import type { MobileSessionTab } from './mobile-session-route-types'
import type { MobileSessionTerminalWebviewModel } from './use-mobile-session-terminal-webview'

type TerminalTripleTapSendOrigin = {
  readonly tab: MobileSessionTab | null
  readonly generation: number
  readonly interaction: number
}

type TerminalTripleTapHandlers = {
  readonly dismissKeyboardAfterAgentSend: (
    origin: TerminalTripleTapSendOrigin,
    accepted: boolean
  ) => void
  readonly handleAccessoryKey: (key: { bytes: string }, handle?: string) => Promise<boolean>
}

export function useMobileSessionTerminalTripleTap(
  scope: MobileSessionTerminalWebviewModel,
  { dismissKeyboardAfterAgentSend, handleAccessoryKey }: TerminalTripleTapHandlers
) {
  const {
    activeSessionTab,
    getLiveInteractionGeneration,
    getSendCompletionGeneration,
    handleTerminalInteraction,
    liveInputFocusTimerRef,
    tripleTapEnterEnabled,
    visibleTerminalHandlesRef
  } = scope

  return useCallback(
    async (handle: string) => {
      if (!tripleTapEnterEnabled || !visibleTerminalHandlesRef.current.includes(handle)) {
        return
      }
      clearTerminalLiveInputFocusTimer(liveInputFocusTimerRef)
      handleTerminalInteraction(handle)
      const sendOrigin = {
        tab: activeSessionTab,
        generation: getSendCompletionGeneration(),
        interaction: getLiveInteractionGeneration()
      }
      const accepted = await handleAccessoryKey({ bytes: '\r' }, handle)
      dismissKeyboardAfterAgentSend(
        sendOrigin,
        accepted && sendOrigin.interaction === getLiveInteractionGeneration()
      )
    },
    [
      activeSessionTab,
      dismissKeyboardAfterAgentSend,
      getLiveInteractionGeneration,
      getSendCompletionGeneration,
      handleAccessoryKey,
      handleTerminalInteraction,
      liveInputFocusTimerRef,
      tripleTapEnterEnabled,
      visibleTerminalHandlesRef
    ]
  )
}
