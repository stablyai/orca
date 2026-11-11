import { useContext, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import { MobileDictationLiveContext } from '../../../dictation/mobile-dictation-live-context'
import type { MobileNativeChatSendIntent } from './mobile-native-chat-send'

const NO_COUNTDOWN = () => null
const NO_SUBSCRIPTION = () => () => {}
const NOTHING_TO_WITHDRAW = () => {}

// The composer's side of "Send when dictation ends": its chat's countdown, and the takeovers that withdraw it and keep the draft.
export function useMobileNativeChatComposerAutoSend(draftScopeKey: string | null | undefined) {
  const autoSend = useContext(MobileDictationLiveContext)?.autoSend ?? null
  const countdown = useSyncExternalStore(
    autoSend?.subscribe ?? NO_SUBSCRIPTION,
    autoSend?.getSnapshot ?? NO_COUNTDOWN
  )
  const withdraw = autoSend?.withdraw ?? NOTHING_TO_WITHDRAW
  return {
    countdown: countdown?.scope === draftScopeKey ? countdown : null,
    withdraw,
    takeOver:
      <Args extends unknown[]>(handler: (...args: Args) => void) =>
      (...args: Args): void => {
        withdraw()
        handler(...args)
      }
  }
}

// The chat's Send, which the countdown presses when it ends; a queued-message edit has none, so it never sends on its own.
export function useMobileNativeChatSendWhenDictationEnds(
  draftScopeKey: string | null | undefined,
  onSend: (intent?: MobileNativeChatSendIntent, keepFocus?: boolean) => void,
  // A Send an agent prompt holds would refuse the countdown's send, so none starts and a running one ends.
  sendHeld: boolean
): (intent?: MobileNativeChatSendIntent, keepFocus?: boolean) => void {
  const autoSend = useContext(MobileDictationLiveContext)?.autoSend ?? null
  const sendRef = useRef(onSend)
  useLayoutEffect(() => {
    sendRef.current = onSend
  })
  useEffect(() => {
    if (!autoSend || !draftScopeKey || sendHeld) {
      return
    }
    return autoSend.register(draftScopeKey, () => sendRef.current())
  }, [autoSend, draftScopeKey, sendHeld])
  // A tap on Send during the countdown sends now, once.
  return (intent, keepFocus) => {
    autoSend?.withdraw()
    onSend(intent, keepFocus)
  }
}
