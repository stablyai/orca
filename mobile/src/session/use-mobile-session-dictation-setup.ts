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
import type { DictationTerm } from '../../../src/shared/dictation-dictionary'
import {
  DEFAULT_STOP_AFTER_SILENCE_SECONDS,
  stopAfterSilenceSeconds,
  type StopAfterSilenceSeconds
} from '../../../src/shared/dictation-silence-stop'

// The computer's dictation settings as this session reads them: mic shown, mode, filler switch, and whether setup is needed first.
export function useMobileSessionDictationSetup(scope: MobileSessionFeedbackCapabilitiesModel) {
  const { client, connState, worktreeId, setShowDictationSetup, setDictationMode } = scope
  const { setDictationEnabled } = scope
  // The phone's own recognizer needs no computer setup, and chat inserts its words on the phone.
  const phoneDictation = usePhoneDictationReady()
  // The host's filler switch and this worktree's terms, kept from its last setup read; fillers on until one says otherwise.
  const [removeFillerWords, setRemoveFillerWords] = useState(true)
  const [dictationTerms, setDictationTerms] = useState<DictationTerm[] | undefined>(undefined)
  const [silenceSeconds, setSilenceSeconds] = useState<StopAfterSilenceSeconds>(
    DEFAULT_STOP_AFTER_SILENCE_SECONDS
  )
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
      const setup = await fetchDictationSetup(client, worktreeId)
      if (read === dictationSettingsReadRef.current) {
        setDictationMode(setup.dictationMode)
        setRemoveFillerWords(setup.removeFillerWords !== false)
        setDictationTerms(setup.dictationTerms)
        setSilenceSeconds(stopAfterSilenceSeconds(setup))
        setDictationEnabled(!dictationMicHidden(setup))
        dictationNeedsSetupRef.current = dictationNeedsSetup(setup)
      }
    } catch {
      // Keep the last settings when an older host cannot report them.
    }
  }, [client, connState, phoneDictation.refresh, setDictationEnabled, setDictationMode, worktreeId])

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
    dictationTerms,
    silenceSeconds,
    dictationNeedsSetupRef,
    closeDictationSetup,
    refreshDictationMode
  }
}
