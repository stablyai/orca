import { useMemo } from 'react'
import type { useMobileStructuredAgentOptions } from './use-mobile-structured-agent-options'

export function useMobileStructuredSendController(
  options: Pick<
    ReturnType<typeof useMobileStructuredAgentOptions>,
    | 'conversationCommands'
    | 'invokeStructuredOption'
    | 'optionSnapshot'
    | 'setStructuredOption'
    | 'sendSelection'
  >
) {
  const {
    conversationCommands,
    invokeStructuredOption,
    optionSnapshot,
    setStructuredOption,
    sendSelection
  } = options
  // Stable across renders, or the send callback is rebuilt on every streamed frame.
  const sendController = useMemo(
    () => ({
      snapshot: optionSnapshot,
      sendSelection,
      setOption: setStructuredOption,
      invokeAction: invokeStructuredOption,
      conversationCommands
    }),
    [
      conversationCommands,
      invokeStructuredOption,
      optionSnapshot,
      setStructuredOption,
      sendSelection
    ]
  )

  return sendController
}
