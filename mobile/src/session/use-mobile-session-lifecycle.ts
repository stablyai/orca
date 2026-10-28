import { settleSessionPreferenceRead } from './session-preference-read'
import { useEffect, useRef, useCallback, useState } from 'react'
import { AppState, type AppStateStatus, Platform } from 'react-native'
import { useFocusEffect } from 'expo-router'
import { loadHosts } from '../transport/host-store'
import { loadTerminalAccessoryLayout } from '../terminal/terminal-accessory-layout'
import {
  recoverActiveTerminalAfterForeground,
  shouldRecoverTerminalOnAppStateChange
} from '../terminal/terminal-foreground-recovery'
import { loadCustomKeys } from '../terminal/terminal-custom-keys'
import type { MobileSessionTabReconciliationModel } from './use-mobile-session-tab-reconciliation'

export function useMobileSessionLifecycle(scope: MobileSessionTabReconciliationModel) {
  const [customKeysLoaded, setCustomKeysLoaded] = useState(false)
  const [accessoryLayoutLoaded, setAccessoryLayoutLoaded] = useState(false)
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
    subscribeToTerminal
  } = scope
  // Shared-client authentication owns identity; this host read supplies only connection hints.
  useEffect(() => {
    if (!hostId) {
      return
    }
    let stale = false
    void loadHosts().then((hosts) => {
      if (stale) {
        return
      }
      const host = hosts.find((h) => h.id === hostId)
      if (host) {
        setHostEndpoint(host.endpoint)
      }
    })
    return () => {
      stale = true
    }
  }, [hostId])

  useEffect(() => {
    let active = true
    void settleSessionPreferenceRead(loadCustomKeys()).then((keys) => {
      if (active) {
        if (keys) {
          setCustomKeys(keys)
        }
        setCustomKeysLoaded(true)
      }
    })
    return () => {
      active = false
    }
  }, [])

  const layoutReadRevisionRef = useRef(0)
  const refreshAccessoryLayout = useCallback(() => {
    const revision = ++layoutReadRevisionRef.current
    void settleSessionPreferenceRead(loadTerminalAccessoryLayout()).then((layout) => {
      if (layoutReadRevisionRef.current === revision) {
        if (layout) {
          setVisibleBuiltInIds(layout.visibleBuiltInIds)
        }
        setAccessoryLayoutLoaded(true)
      }
    })
    return () => {
      if (layoutReadRevisionRef.current === revision) {
        layoutReadRevisionRef.current += 1
      }
    }
  }, [])

  useFocusEffect(refreshAccessoryLayout)

  useEffect(() => {
    const sub = AppState.addEventListener('change', (s: AppStateStatus) => {
      if (s === 'active') {
        refreshAccessoryLayout()
      }
    })
    return () => {
      layoutReadRevisionRef.current += 1
      sub.remove()
    }
  }, [refreshAccessoryLayout])

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
      // WKWebView can resume blank without ready; clear the latch so init waits for a fresh pong.
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

  // Repeat resume recovery after reconnect or an iOS-blanked WebView can remain stale.
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
    accessoryPreferencesReady: customKeysLoaded && accessoryLayoutLoaded,
    pendingForegroundRecoveryRef
  }
}

export type MobileSessionLifecycleModel = MobileSessionTabReconciliationModel &
  ReturnType<typeof useMobileSessionLifecycle>
