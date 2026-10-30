import { useCallback, useRef } from 'react'
import { AppState } from 'react-native'
import { useFocusEffect } from 'expo-router'
import {
  dictationMicHidden,
  dictationNeedsSetup,
  fetchDictationSetup
} from '../dictation/mobile-dictation-setup'
import { resolveMobileDictationAutoSendDelayMs } from './mobile-dictation-auto-send'
import type { MobileSessionFeedbackCapabilitiesModel } from './use-mobile-session-feedback-capabilities'

// The host's dictation setup, read when the screen gains focus and when the app returns to the foreground.
export function useMobileDictationHostSetup({
  client,
  connState,
  setDictationMode,
  setDictationEnabled,
  setShowDictationSetup
}: MobileSessionFeedbackCapabilitiesModel) {
  // Only a host setup read sets this; while false, the host's start refusal decides (older hosts, first tap before the read).
  const dictationNeedsSetupRef = useRef(false)
  // The host's "Send when dictation ends" setting, read with the dictation mode.
  const autoSendSettingRef = useRef({
    enabled: false,
    delayMs: resolveMobileDictationAutoSendDelayMs(undefined)
  })

  const dictationSettingsReadRef = useRef(0)
  const refreshDictationMode = useCallback(async () => {
    const read = ++dictationSettingsReadRef.current
    if (!client || connState !== 'connected') {
      return
    }
    try {
      const setup = await fetchDictationSetup(client)
      if (read === dictationSettingsReadRef.current) {
        setDictationMode(setup.dictationMode)
        setDictationEnabled(!dictationMicHidden(setup))
        dictationNeedsSetupRef.current = dictationNeedsSetup(setup)
        autoSendSettingRef.current = {
          enabled: setup.autoSendAfterDictation === true,
          delayMs: resolveMobileDictationAutoSendDelayMs(setup.autoSendDelayMs)
        }
      }
    } catch {
      // Keep the last settings when an older host cannot report them.
    }
  }, [client, connState, setDictationEnabled, setDictationMode])

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
    dictationNeedsSetupRef,
    autoSendSettingRef,
    refreshDictationMode,
    closeDictationSetup
  }
}
