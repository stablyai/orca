import { useCallback, useEffect, useState } from 'react'
import { AppState } from 'react-native'
import { useFocusEffect } from 'expo-router'
import { MobileDictationAutoSend } from '../dictation/mobile-dictation-auto-send'

// This screen's "Send when dictation ends", withdrawn whenever the user walks away from the chat it was dictated into.
export function useMobileSessionDictationAutoSend(connected: boolean): MobileDictationAutoSend {
  const [autoSend] = useState(() => new MobileDictationAutoSend())
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
