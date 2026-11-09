import { useCallback, useRef, useState } from 'react'
import { AppState } from 'react-native'
import { useFocusEffect } from 'expo-router'
import { usePhoneDictationReady } from '../hooks/use-phone-dictation-ready'
import {
  dictationMicHidden,
  dictationNeedsSetup,
  fetchDictationSetup
} from '../dictation/mobile-dictation-setup'
import type { MobileSessionFeedbackCapabilitiesModel } from './use-mobile-session-feedback-capabilities'

// The computer's dictation settings as this session reads them: mic shown, mode, filler switch, and whether setup is needed first.
export function useMobileSessionDictationSetup(scope: MobileSessionFeedbackCapabilitiesModel) {
  const { client, connState, setShowDictationSetup, setDictationMode, setDictationEnabled } = scope
  // The phone's own recognizer needs no computer setup, and chat inserts its words on the phone.
  const phoneDictation = usePhoneDictationReady()
  // The host's filler switch, kept from its last setup read; on until one says otherwise.
  const [removeFillerWords, setRemoveFillerWords] = useState(true)
  // Only a host setup read sets this; while false, the host's start refusal decides (older hosts, first tap before the read).
  const dictationNeedsSetupRef = useRef(false)

  const dictationSettingsReadRef = useRef(0)
  const refreshDictationMode = useCallback(async () => {
    const read = ++dictationSettingsReadRef.current
    void phoneDictation.refresh()
    if (!client || connState !== 'connected') {
      return
    }
    try {
      const setup = await fetchDictationSetup(client)
      if (read === dictationSettingsReadRef.current) {
        setDictationMode(setup.dictationMode)
        setRemoveFillerWords(setup.removeFillerWords !== false)
        setDictationEnabled(!dictationMicHidden(setup))
        dictationNeedsSetupRef.current = dictationNeedsSetup(setup)
      }
    } catch {
      // Keep the last settings when an older host cannot report them.
    }
  }, [client, connState, phoneDictation.refresh, setDictationEnabled, setDictationMode])

  // The sheet may have changed host setup: let the host judge taps until the fresh read lands.
  const closeDictationSetup = useCallback(() => {
    setShowDictationSetup(false)
    dictationNeedsSetupRef.current = false
    void refreshDictationMode()
  }, [refreshDictationMode, setShowDictationSetup])

  useFocusEffect(
    useCallback(() => {
      void refreshDictationMode()
      const subscription = AppState.addEventListener('change', (state) => {
        if (state === 'active') {
          void refreshDictationMode()
        }
      })
      return () => {
        // Late replies from a retired connection or focus must not rebind the mic.
        dictationSettingsReadRef.current += 1
        subscription.remove()
      }
    }, [refreshDictationMode])
  )

  return {
    phoneDictation,
    removeFillerWords,
    dictationNeedsSetupRef,
    closeDictationSetup,
    refreshDictationMode
  }
}
