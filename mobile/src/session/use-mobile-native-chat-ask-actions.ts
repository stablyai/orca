import { useCallback, useLayoutEffect, useRef, type Dispatch, type SetStateAction } from 'react'
import {
  formatAskAnswer,
  type AskAnswerSelection,
  type AskPrompt
} from '../../../src/shared/native-chat-ask'
import { isMobileAsyncAsk, mobileNativeChatAskKey } from './mobile-native-chat-async-ask'
import { useNativeChatAcceptedAction } from './use-native-chat-action-outcomes'

/** Async choices prepare an ordinary message; only blocking prompts write selector keys. */
export function useMobileNativeChatAskActions(args: {
  prompt: AskPrompt | null
  setComposerText: Dispatch<SetStateAction<string>>
  onSendResolved: () => void
  streamIdentity: string
  answerBlocking: (prompt: AskPrompt, selections: AskAnswerSelection[]) => Promise<boolean>
  cancelBlocking: () => Promise<boolean>
}): {
  answer: (prompt: AskPrompt, selections: AskAnswerSelection[]) => Promise<boolean>
  cancel: () => Promise<boolean>
} {
  const { prompt, setComposerText, onSendResolved, streamIdentity } = args
  const origin = JSON.stringify([streamIdentity, mobileNativeChatAskKey(prompt)])
  const activeOrigin = useRef<string | null>(origin)
  useLayoutEffect(() => {
    activeOrigin.current = origin
    return () => {
      activeOrigin.current = null
    }
  }, [origin])
  const answerBlocking = useNativeChatAcceptedAction(args.answerBlocking, onSendResolved)
  const cancelBlocking = useNativeChatAcceptedAction(args.cancelBlocking, onSendResolved)
  const answer = useCallback(
    async (selectedPrompt: AskPrompt, selections: AskAnswerSelection[]) => {
      if (!isMobileAsyncAsk(selectedPrompt)) {
        return answerBlocking(selectedPrompt, selections)
      }
      if (
        activeOrigin.current !== origin ||
        mobileNativeChatAskKey(selectedPrompt) !== mobileNativeChatAskKey(prompt)
      ) {
        return false
      }
      const answers = selectedPrompt.questions.map((question, index) => {
        const text = formatAskAnswer({ questions: [question] }, [
          selections[index] ?? { indices: [] }
        ])
        return text ? `${question.question}\n${text}` : ''
      })
      if (answers.some((text) => !text)) {
        return false
      }
      const text = answers.join('\n\n')
      setComposerText((previous) => (previous ? `${previous}\n\n${text}` : text))
      return true
    },
    [answerBlocking, origin, prompt, setComposerText]
  )
  const cancel = useCallback(
    async () => (isMobileAsyncAsk(prompt) ? true : cancelBlocking()),
    [cancelBlocking, prompt]
  )
  return { answer, cancel }
}
