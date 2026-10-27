import { useMemo } from 'react'
import type { AgentStatusEntry } from '../../../../../src/shared/agent-status-types'
import type { AskPrompt } from '../../../../../src/shared/native-chat-ask'
import {
  resolveNativeChatInteractivePromptCard,
  type ChatApproval
} from '../../../../../src/shared/native-chat-interactive-prompt'
import { nativeChatPromptWaitStartedAt } from '../../../../../src/shared/native-chat-prompt-dismiss-key'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat-types'
import {
  useMobileStructuredAsyncQuestion,
  type MobileStructuredAskSession
} from '../../use-mobile-structured-async-question'

export type MobileNativeChatPrompts = {
  /** A terminal chat's approval; a structured chat's journal prompts are its own cards. */
  permission: ChatApproval | null
  ask: AskPrompt | null
  /** The host wait's start for a status-backed card; null for a transcript-only one. */
  waitStartedAt: number | null
  /** Set in a structured chat, whose ask is answered by a send rather than a terminal write. */
  structuredAnswer: ReturnType<typeof useMobileStructuredAsyncQuestion>['answer']
}

export function useMobileNativeChatPrompts(args: {
  enabled: boolean
  /** A structured chat reads only its async question here; its journal prompts are its own cards. */
  structured?: MobileStructuredAskSession | null
  status: AgentStatusEntry | null | undefined
  messages: readonly NativeChatMessage[]
  // Unsettled/retained reconnect history may contain answered asks and cannot supply current prompt cards.
  transcriptLoading: boolean
}): MobileNativeChatPrompts {
  const { enabled, structured = null, status, messages, transcriptLoading } = args
  const interactivePrompt = status?.interactivePrompt
  const toolName = status?.toolName
  const agent = status?.agentType
  const card = useMemo(
    () =>
      resolveNativeChatInteractivePromptCard({
        interactivePrompt,
        toolName,
        agent,
        messages,
        transcriptSettled: !transcriptLoading
      }),
    [interactivePrompt, toolName, agent, messages, transcriptLoading]
  )
  const structuredAsk = useMobileStructuredAsyncQuestion({
    structured,
    messages,
    transcriptLoading
  })
  if (structured) {
    return {
      permission: null,
      ask: enabled ? structuredAsk.ask : null,
      waitStartedAt: null,
      structuredAnswer: structuredAsk.answer
    }
  }
  // An approval needs no resolved chat; an ask waits for one.
  const shown = enabled || card?.kind === 'approval' ? card : null
  return {
    structuredAnswer: null,
    permission: shown?.kind === 'approval' ? shown.approval : null,
    ask: shown?.kind === 'question' ? shown.prompt : null,
    waitStartedAt: nativeChatPromptWaitStartedAt(shown, status)
  }
}
