import { useState, useRef, useCallback } from 'react'
import { Animated } from 'react-native'
import { useFocusEffect } from 'expo-router'
import { reconcileMobileSessionCreateWarningState } from './mobile-session-create-warning-state'
import type { MobileSessionTerminalRuntimeModel } from './use-mobile-session-terminal-runtime'
import type { HostSessionTabOperations } from './host-session-tab-operations'

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
    resetLiveInputFocus,
    sessionTabOperations,
    quickCommandsOpenFor
  } = scope
  useFocusEffect(
    useCallback(() => {
      // Expo retains this route while pushed screens are visible.
      return resetLiveInputFocus
    }, [resetLiveInputFocus])
  )
  const [runtimeCapabilitySnapshot, setRuntimeCapabilitySnapshot] = useState<{
    operations: HostSessionTabOperations
    browserScreencastSupported: boolean
    agentSessionHistorySupported: boolean
    quickCommandsSupported: boolean
  } | null>(null)
  const currentRuntimeCapabilities =
    connState === 'connected' && runtimeCapabilitySnapshot?.operations === sessionTabOperations
      ? runtimeCapabilitySnapshot
      : null
  const browserScreencastSupported = currentRuntimeCapabilities?.browserScreencastSupported ?? null
  // Why: hosts without aiVault.v1 reject listSessions, so hide the header entry instead of a dead-end "update this host" panel.
  const agentSessionHistorySupported =
    currentRuntimeCapabilities?.agentSessionHistorySupported ?? null
  const quickCommandsSupported = currentRuntimeCapabilities?.quickCommandsSupported ?? null
  const showQuickCommands =
    quickCommandsOpenFor !== null && quickCommandsOpenFor === sessionTabOperations
  // Why: stable callbacks (handleFileTap) read the live value via this ref, since
  // the capability probe resolves after the callbacks are created.
  const browserScreencastSupportedRef = useRef(browserScreencastSupported)
  // react-doctor-disable-next-line react-doctor/no-ref-current-in-render
  browserScreencastSupportedRef.current = browserScreencastSupported
  // Why: terminal gesture/input callbacks are stable/imperative, so keep their refs current before commit, not in a later effect.
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
  // Why: Expo can reuse this screen for a new route; reconcile before paint so a dismissed old warning doesn't flash.
  if (reconciledCreateWarningState !== createWarningState) {
    // react-doctor-disable-next-line react-doctor/no-prop-callback-in-render
    setCreateWarningState(reconciledCreateWarningState)
  }
  const createWarning = reconciledCreateWarningState.visible

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
  return {
    browserScreencastSupported,
    agentSessionHistorySupported,
    quickCommandsSupported,
    setRuntimeCapabilitySnapshot,
    showQuickCommands,
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
