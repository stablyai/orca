import { useCallback, useMemo } from 'react'
import {
  extractPendingMessageReplyAsk,
  formatAskAnswer,
  type AskAnswerSelection,
  type AskPrompt
} from '../../../src/shared/native-chat-ask'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import type { useMobileStructuredAgentSession } from './use-mobile-structured-agent-session'

export type MobileStructuredAskSession = Pick<
  ReturnType<typeof useMobileStructuredAgentSession>,
  'permission' | 'question' | 'sendWithOutcome'
>

// Keep nonblocking structured questions pending until the next user message; answer by ordinary send without touching the draft.
export function useMobileStructuredAsyncQuestion(args: {
  structured: MobileStructuredAskSession | null
  messages: readonly NativeChatMessage[]
  transcriptLoading: boolean
}): {
  ask: AskPrompt | null
  answer: ((prompt: AskPrompt, selections: AskAnswerSelection[]) => Promise<boolean>) | null
} {
  const { structured, messages, transcriptLoading } = args
  // A journal prompt takes the card slot first, as on desktop.
  const readable =
    structured !== null && !structured.permission && !structured.question && !transcriptLoading
  const ask = useMemo(
    () => (readable ? extractPendingMessageReplyAsk(messages) : null),
    [readable, messages]
  )
  const sendWithOutcome = structured?.sendWithOutcome
  const answer = useCallback(
    async (prompt: AskPrompt, selections: AskAnswerSelection[]) =>
      sendWithOutcome !== undefined &&
      (await sendWithOutcome(formatAskAnswer(prompt, selections))) !== 'rejected',
    [sendWithOutcome]
  )
  return { ask, answer: structured ? answer : null }
}
