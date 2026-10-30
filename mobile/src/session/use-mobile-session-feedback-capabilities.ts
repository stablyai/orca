import { useState, useRef, useCallback, useEffect } from 'react'
import { Animated } from 'react-native'
import { translate } from '../i18n/mobile-i18n'
import { reconcileMobileSessionCreateWarningState } from './mobile-session-create-warning-state'
import type { MobileSessionTerminalRuntimeModel } from './use-mobile-session-terminal-runtime'
import type { StructuredAgentSessionHostSupport } from './mobile-structured-agent-session-host-support'

export function useMobileSessionFeedbackCapabilities(scope: MobileSessionTerminalRuntimeModel) {
  const {
    client,
    connState,
    initialCreateWarning,
    sessionTabs,
    sessionTabsRef,
    activeSessionTabId,
    activeSessionTabIdRef,
    markdownDocs,
    markdownDocsRef,
    createWarningState,
    setCreateWarningState,
    setToastMessage,
    toastOpacityRef,
    toastHideTimerRef,
    toastSeqRef,
    clientRef,
    connStateRef,
    activeSessionTabTypeRef,
    delayedActionTimersRef,
    activeSessionTab,
    onLiveInputSendFailureRef
  } = scope
  const [browserScreencastSupported, setBrowserScreencastSupported] = useState<boolean | null>(null)
  // Hide history entry when the host cannot serve it rather than opening a dead end.
  const [agentSessionHistorySupported, setAgentSessionHistorySupported] = useState<boolean | null>(
    null
  )
  const [quickCommandsSupported, setQuickCommandsSupported] = useState<boolean | null>(null)
  const [quickCommandAgentPromptMaxLength, setQuickCommandAgentPromptMaxLength] = useState<
    number | null
  >(null)
  // Reuse the shared capability probe so session features cannot diverge across status caches.
  const [agentSessionHostSupport, setAgentSessionHostSupport] =
    useState<StructuredAgentSessionHostSupport | null>(null)
  // Stable handlers read live capabilities after the asynchronous probe resolves.
  const browserScreencastSupportedRef = useRef(browserScreencastSupported)
  // react-doctor-disable-next-line react-doctor/no-ref-current-in-render
  browserScreencastSupportedRef.current = browserScreencastSupported
  // Imperative input callbacks need current refs before commit, not a later passive effect.
  clientRef.current = client
  connStateRef.current = connState
  activeSessionTabTypeRef.current = activeSessionTab?.type ?? null
  sessionTabsRef.current = sessionTabs
  activeSessionTabIdRef.current = activeSessionTabId
  markdownDocsRef.current = markdownDocs
  const reconciledCreateWarningState = reconcileMobileSessionCreateWarningState(
    createWarningState,
    initialCreateWarning
  )
  // Reconcile reused-route warning state before paint so dismissed old feedback cannot flash.
  if (reconciledCreateWarningState !== createWarningState) {
    // react-doctor-disable-next-line react-doctor/no-prop-callback-in-render
    setCreateWarningState(reconciledCreateWarningState)
  }
  const createWarning = reconciledCreateWarningState.visible

  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const clearDelayedActionTimers = useCallback(() => {
    for (const timer of delayedActionTimersRef.current) {
      clearTimeout(timer)
    }
    delayedActionTimersRef.current.clear()
  }, [])

  const scheduleDelayedAction = useCallback((fn: () => void, ms: number) => {
    const timer = setTimeout(() => {
      delayedActionTimersRef.current.delete(timer)
      fn()
    }, ms)
    delayedActionTimersRef.current.add(timer)
  }, [])

  const clearToastHideTimer = useCallback(() => {
    if (!toastHideTimerRef.current) {
      return
    }
    clearTimeout(toastHideTimerRef.current)
    toastHideTimerRef.current = null
  }, [])

  const showToast = useCallback(
    (message: string, durationMs = 1200) => {
      if (!mountedRef.current) {
        return
      }
      const seq = toastSeqRef.current + 1
      toastSeqRef.current = seq
      clearToastHideTimer()
      setToastMessage(message)
      Animated.timing(toastOpacityRef.current, {
        toValue: 1,
        duration: 150,
        useNativeDriver: true
      }).start(({ finished }) => {
        if (!finished || toastSeqRef.current !== seq) {
          return
        }
        toastHideTimerRef.current = setTimeout(() => {
          toastHideTimerRef.current = null
          Animated.timing(toastOpacityRef.current, {
            toValue: 0,
            duration: 200,
            useNativeDriver: true
          }).start((result) => {
            if (result.finished && toastSeqRef.current === seq) {
              setToastMessage(null)
            }
          })
        }, durationMs)
      })
    },
    [clearToastHideTimer]
  )
  useEffect(() => {
    onLiveInputSendFailureRef.current = (failure) => {
      showToast(
        failure === 'input-too-large'
          ? translate(
              'session.useSessionTerminalSendActions.inputTooLarge',
              'Input too large (max 256 KiB)'
            )
          : translate(
              'session.useSessionTerminalSendActions.liveInputInterrupted',
              'Live input interrupted. Field cleared; check the terminal before continuing.'
            ),
        3000
      )
    }
    return () => {
      onLiveInputSendFailureRef.current = () => {}
    }
  }, [onLiveInputSendFailureRef, showToast])
  return {
    browserScreencastSupported,
    setBrowserScreencastSupported,
    agentSessionHistorySupported,
    setAgentSessionHistorySupported,
    quickCommandsSupported,
    setQuickCommandsSupported,
    quickCommandAgentPromptMaxLength,
    setQuickCommandAgentPromptMaxLength,
    agentSessionHostSupport,
    setAgentSessionHostSupport,
    browserScreencastSupportedRef,
    reconciledCreateWarningState,
    createWarning,
    clearDelayedActionTimers,
    scheduleDelayedAction,
    clearToastHideTimer,
    showToast
  }
}

export type MobileSessionFeedbackCapabilitiesModel = MobileSessionTerminalRuntimeModel &
  ReturnType<typeof useMobileSessionFeedbackCapabilities>
