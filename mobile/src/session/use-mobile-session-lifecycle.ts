import { useEffect, useRef, useCallback } from 'react'
import { AppState, type AppStateStatus, Platform } from 'react-native'
import { useFocusEffect } from 'expo-router'
import {
  recoverActiveTerminalAfterForeground,
  shouldRecoverTerminalOnAppStateChange
} from '../terminal/terminal-foreground-recovery'
import type { MobileSessionTabReconciliationModel } from './use-mobile-session-tab-reconciliation'
import { loadSessionNativeHostProfile } from './session-native-host-profile'

export function useMobileSessionLifecycle(scope: MobileSessionTabReconciliationModel) {
  const {
    hostId,
    connState,
    setCustomKeys,
    setVisibleBuiltInIds,
    setHostEndpoint,
    connStateRef,
    terminalRefs,
    initializedHandlesRef,
    activeHandleRef,
    scheduleDelayedAction,
    unsubscribeTerminal,
    subscribeToTerminal,
    sessionDeviceOperations
  } = scope
  // Why: the shared client owns authenticated identity; this host read only supplies connection-hint metadata.
  useEffect(() => {
    if (!hostId) {
      return
    }
    let stale = false
    void loadSessionNativeHostProfile(hostId).then((host) => {
      if (stale) {
        return
      }
      if (host) {
        setHostEndpoint(host.endpoint)
      }
    })
    return () => {
      stale = true
    }
  }, [hostId])

  useFocusEffect(
    useCallback(() => {
      let stale = false
      void sessionDeviceOperations?.loadTerminalAccessoryPreferences().then((preferences) => {
        if (!stale) {
          setCustomKeys(preferences.customKeys)
          setVisibleBuiltInIds(preferences.visibleBuiltInIds)
        }
      })
      return () => {
        stale = true
      }
    }, [sessionDeviceOperations])
  )

  useEffect(() => {
    let mounted = true
    const refresh = () => {
      void sessionDeviceOperations?.loadTerminalAccessoryPreferences().then((preferences) => {
        if (mounted) {
          setCustomKeys(preferences.customKeys)
          setVisibleBuiltInIds(preferences.visibleBuiltInIds)
        }
      })
    }
    const sub = AppState.addEventListener('change', (s: AppStateStatus) => {
      if (s === 'active') {
        refresh()
      }
    })
    return () => {
      mounted = false
      sub.remove()
    }
  }, [sessionDeviceOperations])

  const pendingForegroundRecoveryRef = useRef(false)
  useEffect(() => {
    let previousAppState: AppStateStatus | null = AppState.currentState
    const sub = AppState.addEventListener('change', (nextAppState: AppStateStatus) => {
      const shouldRecover = shouldRecoverTerminalOnAppStateChange(
        previousAppState,
        nextAppState,
        Platform.OS
      )
      previousAppState = nextAppState
      if (!shouldRecover) {
        return
      }
      for (const terminalRef of terminalRefs.current.values()) {
        terminalRef.prepareForForegroundRecovery()
      }
      // Why: iOS can resume a WKWebView with a blank xterm store and no web-ready; invalidate the latch so init waits for the pong.
      const outcome = recoverActiveTerminalAfterForeground({
        activeHandleRef,
        terminalRefs,
        initializedHandlesRef,
        connStateRef,
        unsubscribeTerminal,
        subscribeToTerminal,
        schedule: scheduleDelayedAction
      })
      pendingForegroundRecoveryRef.current = outcome === 'deferred'
    })
    return () => {
      sub.remove()
    }
  }, [scheduleDelayedAction, subscribeToTerminal, unsubscribeTerminal])

  // Why: resume lands mid-reconnect (socket dies in bg); re-run recovery once connected or a blanked WKWebView stays stale.
  useEffect(() => {
    if (connState !== 'connected' || !pendingForegroundRecoveryRef.current) {
      return
    }
    pendingForegroundRecoveryRef.current = false
    if (AppState.currentState !== 'active') {
      return
    }
    recoverActiveTerminalAfterForeground({
      activeHandleRef,
      terminalRefs,
      initializedHandlesRef,
      connStateRef,
      unsubscribeTerminal,
      subscribeToTerminal,
      schedule: scheduleDelayedAction
    })
  }, [connState, scheduleDelayedAction, subscribeToTerminal, unsubscribeTerminal])
  return {
    pendingForegroundRecoveryRef
  }
}

export type MobileSessionLifecycleModel = MobileSessionTabReconciliationModel &
  ReturnType<typeof useMobileSessionLifecycle>
