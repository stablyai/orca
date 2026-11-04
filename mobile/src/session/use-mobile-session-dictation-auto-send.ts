import { useCallback, useEffect, useState } from 'react'
import { AppState } from 'react-native'
import { useFocusEffect } from 'expo-router'
import {
  createMobileDictationAutoSend,
  type MobileDictationAutoSend
} from './mobile-dictation-auto-send'

// The session's pending send, withdrawn whenever the user moves away from the chat it was dictated into.
export function useMobileSessionDictationAutoSend(
  chatScopeKey: string | null,
  chatShown: boolean,
  connected: boolean
): MobileDictationAutoSend {
  const [autoSend] = useState(createMobileDictationAutoSend)

  // A transcript still in flight must not send into a chat other than the one dictated into.
  useEffect(() => {
    autoSend.withdraw()
  }, [autoSend, chatScopeKey, chatShown])

  // Dictation stops when the connection drops, so a reconnect must not resume its send.
  useEffect(() => {
    if (!connected) {
      autoSend.withdraw()
    }
  }, [autoSend, connected])

  useFocusEffect(
    useCallback(() => {
      const subscription = AppState.addEventListener('change', (state) => {
        // A backgrounded or locked phone is the user walking away, not consenting to send.
        if (state !== 'active') {
          autoSend.withdraw()
        }
      })
      return () => {
        autoSend.withdraw()
        subscription.remove()
      }
    }, [autoSend])
  )

  return autoSend
}
