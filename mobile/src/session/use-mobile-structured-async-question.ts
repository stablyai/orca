import { useCallback } from 'react'
import {
  formatAskAnswer,
  type AskAnswerSelection
} from '../../../src/shared/native-chat/input/native-chat-ask-answer'
import { nativeChatAnswerSendIntent } from '../../../src/shared/native-chat/input/native-chat-follow-up-behavior'
import type { AskPrompt } from '../../../src/shared/native-chat/input/native-chat-ask-types'
import type { QueuedMessageCard } from '../../../src/shared/agent-session/view/structured-agent-session-queued-cards'
import type { useMobileStructuredAgentSession } from './use-mobile-structured-agent-session'

export type MobileStructuredAskSession = Pick<
  ReturnType<typeof useMobileStructuredAgentSession>,
  'permission' | 'question' | 'sendWithOutcome' | 'sendFollowUp'
> & {
  /** Cards waiting in the chat's queue; one quoting a question holds it as answered. */
  submissions?: ReturnType<typeof useMobileStructuredAgentSession>['submissions']
  queued?: { cards: readonly Pick<QueuedMessageCard, 'text'>[] }
}

// Card answers reach the current turn without touching the composer draft.
export function useMobileStructuredAsyncQuestion(args: {
  structured: MobileStructuredAskSession | null
  pendingAsk: AskPrompt | null
  transcriptLoading: boolean
}): {
  ask: AskPrompt | null
  answer:
    | ((
        prompt: AskPrompt,
        selections: AskAnswerSelection[],
        onCreated?: (id: string) => void
      ) => Promise<boolean>)
    | null
} {
  const { structured, pendingAsk, transcriptLoading } = args
  // A journal prompt takes the card slot first, as on desktop.
  const readable =
    structured !== null && !structured.permission && !structured.question && !transcriptLoading
  const ask = readable ? pendingAsk : null
  const sendWithOutcome = structured?.sendWithOutcome
  const sendFollowUp = structured?.sendFollowUp
  const answer = useCallback(
    async (prompt: AskPrompt, selections: AskAnswerSelection[], onCreated?: (id: string) => void) =>
      sendWithOutcome !== undefined &&
      (await sendWithOutcome(
        formatAskAnswer(prompt, selections),
        undefined,
        undefined,
        undefined,
        undefined,
        { ...nativeChatAnswerSendIntent(sendFollowUp), ...(onCreated ? { onCreated } : {}) }
      )) !== 'rejected',
    [sendWithOutcome, sendFollowUp]
  )
  return { ask, answer: structured ? answer : null }
}
