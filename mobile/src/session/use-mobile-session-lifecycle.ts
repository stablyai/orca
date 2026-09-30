import { useEffect, useRef, useCallback } from 'react'
import { AppState, type AppStateStatus, Platform } from 'react-native'
import { useFocusEffect } from 'expo-router'
import { loadHosts } from '../transport/host-store'
import { loadTerminalAccessoryLayout } from '../terminal/terminal-accessory-layout'
import {
  recoverActiveTerminalAfterForeground,
  shouldRecoverTerminalOnAppStateChange
} from '../terminal/terminal-foreground-recovery'
import { loadCustomKeys } from '../components/CustomKeyModal'
import type { MobileSessionTabReconciliationModel } from './use-mobile-session-tab-reconciliation'

export function useMobileSessionLifecycle(scope: MobileSessionTabReconciliationModel) {
  const {
    hostId,
    connState,
    customKeysRevisionRef,
    setCustomKeys,
    setTerminalAccessoryLayout,
    setHostEndpoint,
    connStateRef,
    terminalRefs,
    initializedHandlesRef,
    activeHandleRef,
    scheduleDelayedAction,
    unsubscribeTerminal,
    subscribeToTerminal
  } = scope
  // Why: the shared client owns authenticated identity; this host read only supplies connection-hint metadata.
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

  const shortcutRefreshSeqRef = useRef(0)
  useFocusEffect(
    useCallback(() => {
      let stale = false
      const refreshSeq = ++shortcutRefreshSeqRef.current
      const customKeysRevision = customKeysRevisionRef.current
      void Promise.all([loadTerminalAccessoryLayout(), loadCustomKeys()]).then(([layout, keys]) => {
        if (!stale && refreshSeq === shortcutRefreshSeqRef.current) {
          setTerminalAccessoryLayout(layout)
          if (customKeysRevision === customKeysRevisionRef.current) {
            setCustomKeys(keys)
          }
        }
      })
      return () => {
        stale = true
      }
    }, [customKeysRevisionRef, setTerminalAccessoryLayout, setCustomKeys])
  )

  useEffect(() => {
    let mounted = true
    const refresh = () => {
      const refreshSeq = ++shortcutRefreshSeqRef.current
      const customKeysRevision = customKeysRevisionRef.current
      void Promise.all([loadTerminalAccessoryLayout(), loadCustomKeys()]).then(([layout, keys]) => {
        if (mounted && refreshSeq === shortcutRefreshSeqRef.current) {
          setTerminalAccessoryLayout(layout)
          if (customKeysRevision === customKeysRevisionRef.current) {
            setCustomKeys(keys)
          }
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
  }, [customKeysRevisionRef, setTerminalAccessoryLayout, setCustomKeys])

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
