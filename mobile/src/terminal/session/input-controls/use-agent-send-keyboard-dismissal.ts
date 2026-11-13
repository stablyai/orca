import { useCallback } from 'react'
import {
  shouldDismissKeyboardAfterTerminalSend,
  type AgentSendKeyboardDismissalTab
} from './agent-send-keyboard-dismissal'

type AgentSendOrigin = {
  readonly tab: AgentSendKeyboardDismissalTab | null
  readonly generation: number
}

export function useAgentSendKeyboardDismissal(
  dismissSoftwareKeyboard: () => void,
  getSendCompletionGeneration: () => number
) {
  return useCallback(
    (origin: AgentSendOrigin, accepted: boolean): void => {
      if (
        origin.generation === getSendCompletionGeneration() &&
        shouldDismissKeyboardAfterTerminalSend(origin.tab, accepted)
      ) {
        dismissSoftwareKeyboard()
      }
    },
    [dismissSoftwareKeyboard, getSendCompletionGeneration]
  )
}
