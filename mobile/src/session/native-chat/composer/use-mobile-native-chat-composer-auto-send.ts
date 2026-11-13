import { useContext, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import { MobileDictationLiveContext } from '../../../dictation/mobile-dictation-live-context'
import type { MobileNativeChatSendIntent } from './mobile-native-chat-send'

const NO_COUNTDOWN = () => null
const NO_SUBSCRIPTION = () => () => {}
const NOTHING_TO_WITHDRAW = () => {}

export function useMobileDictationAutoSendWithdraw(): () => void {
  return useContext(MobileDictationLiveContext)?.autoSend.withdraw ?? NOTHING_TO_WITHDRAW
}

export function useMobileNativeChatComposerAutoSend(draftScopeKey: string | null | undefined) {
  const autoSend = useContext(MobileDictationLiveContext)?.autoSend ?? null
  const countdown = useSyncExternalStore(
    autoSend?.subscribe ?? NO_SUBSCRIPTION,
    autoSend?.getSnapshot ?? NO_COUNTDOWN
  )
  const withdraw = useMobileDictationAutoSendWithdraw()
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

// A queued-message edit has no Send slot, so it never sends on its own.
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
  return (intent, keepFocus) => {
    autoSend?.withdraw()
    onSend(intent, keepFocus)
  }
}
