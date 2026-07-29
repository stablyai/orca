import { useEffect, useState } from 'react'
import type { AskPrompt } from './mobile-native-chat-ask'

/** Track the answered-ask key so the lingering live status doesn't re-show the
 *  same card. The agent emits a post-tool event with the same prompt right after
 *  an answer, so the card is hidden until a genuinely different question arrives. */
export function useMobileNativeChatAskDismiss(ask?: AskPrompt | null): {
  askKey: string | null
  showAsk: boolean
  dismissAsk: () => void
} {
  const askKey = ask ? JSON.stringify(ask.questions) : null
  const [dismissedAskKey, setDismissedAskKey] = useState<string | null>(null)
  // Once the prompt clears (agent moved on), forget the dismissal so a later
  // question — even an identical one — shows again instead of staying hidden.
  const askPresent = ask != null
  useEffect(() => {
    if (!askPresent) {
      setDismissedAskKey(null)
    }
  }, [askPresent])
  const showAsk = askPresent && askKey !== dismissedAskKey
  const dismissAsk = (): void => setDismissedAskKey(askKey)

  return { askKey, showAsk, dismissAsk }
}
