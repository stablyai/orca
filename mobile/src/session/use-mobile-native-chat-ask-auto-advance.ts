import { useEffect, useRef } from 'react'
import { NATIVE_CHAT_QUESTION_AUTO_ADVANCE_MS } from '../../../src/shared/native-chat-question-auto-advance'

/** Mirrors desktop's useNativeChatQuestionAutoAdvance; shared code cannot import this app's React. */
export function useMobileNativeChatAskAutoAdvance(): {
  schedule: (step: () => void) => void
  cancel: () => void
} {
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const cancel = (): void => clearTimeout(timerRef.current)
  const schedule = (step: () => void): void => {
    cancel()
    timerRef.current = setTimeout(step, NATIVE_CHAT_QUESTION_AUTO_ADVANCE_MS)
  }
  useEffect(() => () => clearTimeout(timerRef.current), [])
  return { schedule, cancel }
}
