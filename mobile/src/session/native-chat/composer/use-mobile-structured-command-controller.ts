import { useMemo } from 'react'
import type { useMobileStructuredAgentOptions } from '../input/use-mobile-structured-agent-options'

type MobileStructuredAgentOptions = ReturnType<typeof useMobileStructuredAgentOptions>

/** What command dispatch reads from a chat's options, stable between answers. */
export function useMobileStructuredCommandController(options: MobileStructuredAgentOptions) {
  const {
    compactInstructions,
    cleanBackgroundTerminals,
    conversationCommands,
    invokeStructuredOption,
    optionSnapshot,
    setStructuredOption
  } = options
  return useMemo(
    () => ({
      snapshot: optionSnapshot,
      setOption: setStructuredOption,
      invokeAction: invokeStructuredOption,
      conversationCommands,
      compactInstructions,
      cleanBackgroundTerminals
    }),
    [
      compactInstructions,
      cleanBackgroundTerminals,
      conversationCommands,
      invokeStructuredOption,
      optionSnapshot,
      setStructuredOption
    ]
  )
}
