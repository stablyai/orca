import { useEffect, useMemo, useRef, useState } from 'react'
import { nativeChatAskDismissKey, type AskPrompt } from './mobile-native-chat-ask'

type AskDismissal = { sessionKey: string | null; askKey: string }
type DetectedAsk = { sessionKey: string | null; askKey: string | null }

/** Track the answered-ask key so the lingering live status doesn't re-show the
 *  same card. The agent emits a post-tool event with the same prompt right after
 *  an answer, so the card is hidden until a genuinely different question arrives.
 *
 *  Owned by the controller, not the chat subtree: the overlay unmounts on a
 *  chat↔terminal view toggle, and a dismissal must survive that round-trip. */
export function useMobileNativeChatAskDismiss(args: {
  ask: AskPrompt | null
  /** Ungated prompt payload. A working/done status hides the card but does not
   *  prove the sticky prompt itself cleared. Required, and never defaulted to
   *  `ask`: reading the gated prompt as the detected one is the resurfacing bug
   *  this hook exists to close. */
  detectedAsk: AskPrompt | null
  /** Tab scope retains dismissals across tab switches. */
  scopeKey: string | null
  /** Provider-session identity distinguishes restarts without growing the tab map. */
  sessionKey: string | null
  /** True while the chat surface can actually observe the prompt. A null ask it
   *  cannot see — off-chat, or before a re-subscribed transcript lands — proves
   *  nothing and must not reset the dismissal; that reset resurfaced the card. */
  observing: boolean
}): {
  askKey: string | null
  showAsk: boolean
  dismissAsk: () => void
} {
  const { ask, detectedAsk, scopeKey, sessionKey, observing } = args
  const askKey = useMemo(() => nativeChatAskDismissKey(ask), [ask])
  const detectedAskKey = useMemo(() => nativeChatAskDismissKey(detectedAsk), [detectedAsk])
  const detectedByScopeRef = useRef(new Map<string | null, DetectedAsk>())
  const [dismissedByScope, setDismissedByScope] = useState<Map<string | null, AskDismissal>>(
    () => new Map()
  )
  useEffect(() => {
    if (observing) {
      detectedByScopeRef.current.set(scopeKey, { sessionKey, askKey: detectedAskKey })
    }
  }, [observing, detectedAskKey, scopeKey, sessionKey])
  // A cleared or genuinely different detected prompt retires the old dismissal.
  useEffect(() => {
    if (observing) {
      setDismissedByScope((previous) => {
        const dismissed = previous.get(scopeKey)
        if (
          dismissed === undefined ||
          (dismissed.sessionKey === sessionKey && dismissed.askKey === detectedAskKey)
        ) {
          return previous
        }
        const next = new Map(previous)
        next.delete(scopeKey)
        return next
      })
    }
  }, [observing, detectedAskKey, scopeKey, sessionKey])
  const dismissed = dismissedByScope.get(scopeKey)
  const showAsk =
    askKey !== null && !(dismissed?.sessionKey === sessionKey && dismissed.askKey === askKey)
  const dismissAsk = (): void => {
    const detected = detectedByScopeRef.current.get(scopeKey)
    if (askKey !== null && detected?.sessionKey === sessionKey && detected.askKey === askKey) {
      setDismissedByScope((previous) => {
        const current = previous.get(scopeKey)
        if (current?.sessionKey === sessionKey && current.askKey === askKey) {
          return previous
        }
        return new Map(previous).set(scopeKey, { sessionKey, askKey })
      })
    }
  }

  return { askKey, showAsk, dismissAsk }
}
