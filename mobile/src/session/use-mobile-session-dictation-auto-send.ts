import { useCallback, useEffect, useLayoutEffect, useState } from 'react'
import { AppState } from 'react-native'
import { useFocusEffect } from 'expo-router'
import { MobileDictationAutoSend } from '../dictation/mobile-dictation-auto-send'
import { resolveMobileNativeChatSessionId } from './native-chat/mobile-native-chat-eligibility'
import type { MobileSessionFeedbackCapabilitiesModel } from './use-mobile-session-feedback-capabilities'

// This screen's "Send when dictation ends", withdrawn whenever the user walks away from the chat it was dictated into.
export function useMobileSessionDictationAutoSend({
  connState,
  activeHandle,
  activeSessionTab
}: Pick<
  MobileSessionFeedbackCapabilitiesModel,
  'connState' | 'activeHandle' | 'activeSessionTab'
>): MobileDictationAutoSend {
  const [autoSend] = useState(() => new MobileDictationAutoSend())
  const connected = connState === 'connected'
  // What the chat in front sends to: the terminal a terminal-backed chat writes, and the agent session.
  // A replaced session or terminal under the same tab is another conversation, and so is a first session id.
  const conversation = JSON.stringify([
    activeHandle,
    resolveMobileNativeChatSessionId(activeSessionTab ?? null)
  ])
  // Before any timer can fire, so a countdown never presses a Send that now goes elsewhere.
  useLayoutEffect(() => autoSend.sendsTo(conversation), [autoSend, conversation])
  // Leaving the screen keeps the dictation going, but its words land as a draft.
  useFocusEffect(useCallback(() => () => autoSend.withdraw(), [autoSend]))
  // 'inactive' also covers the first microphone prompt, so only a backgrounded or locked phone counts.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'background') {
        autoSend.withdraw()
      }
    })
    return () => subscription.remove()
  }, [autoSend])
  // A reconnect must not resume a send the drop interrupted.
  useEffect(() => {
    if (!connected) {
      autoSend.withdraw()
    }
  }, [autoSend, connected])
  return autoSend
}
