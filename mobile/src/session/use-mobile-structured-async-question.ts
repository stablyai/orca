import { useCallback } from 'react'
import {
  formatAskAnswer,
  type AskAnswerSelection
} from '../../../src/shared/native-chat-ask-answer'
import type { AskPrompt } from '../../../src/shared/native-chat/input/native-chat-ask-types'
import type { useMobileStructuredAgentSession } from './use-mobile-structured-agent-session'

export type MobileStructuredAskSession = Pick<
  ReturnType<typeof useMobileStructuredAgentSession>,
  'permission' | 'question' | 'sendWithOutcome'
> & { asyncQuestion?: AskPrompt | null }

// Keep nonblocking structured questions pending until the next user message; answer by ordinary send without touching the draft.
export function useMobileStructuredAsyncQuestion(args: {
  structured: MobileStructuredAskSession | null
  pendingAsk: AskPrompt | null
  transcriptLoading: boolean
}): {
  ask: AskPrompt | null
  answer: ((prompt: AskPrompt, selections: AskAnswerSelection[]) => Promise<boolean>) | null
} {
  const { structured, pendingAsk, transcriptLoading } = args
  // A journal prompt takes the card slot first, as on desktop.
  const readable =
    structured !== null &&
    !structured.permission &&
    !structured.question &&
    (structured.asyncQuestion !== undefined || !transcriptLoading)
  const ask = readable
    ? structured.asyncQuestion !== undefined
      ? structured.asyncQuestion
      : pendingAsk
    : null
  const sendWithOutcome = structured?.sendWithOutcome
  const answer = useCallback(
    async (prompt: AskPrompt, selections: AskAnswerSelection[]) =>
      sendWithOutcome !== undefined &&
      (await sendWithOutcome(formatAskAnswer(prompt, selections))) !== 'rejected',
    [sendWithOutcome]
  )
  return { ask, answer: structured ? answer : null }
}
