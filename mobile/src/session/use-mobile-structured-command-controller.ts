import type { AgentJournalSkillRef } from '../../../src/shared/agent-session/journal/agent-session-journal-types'
import { useMemo } from 'react'
import type { useMobileStructuredAgentOptions } from './use-mobile-structured-agent-options'

type MobileStructuredAgentOptions = ReturnType<typeof useMobileStructuredAgentOptions>

/** What command dispatch reads from a chat's options, stable between answers. */
export function useMobileStructuredCommandController(
  options: MobileStructuredAgentOptions,
  openSideChat?: (question: string, skills?: readonly AgentJournalSkillRef[]) => Promise<boolean>
) {
  const {
    compactInstructions,
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
      openSideChat
    }),
    [
      compactInstructions,
      openSideChat,
      conversationCommands,
      invokeStructuredOption,
      optionSnapshot,
      setStructuredOption
    ]
  )
}
