import { useCallback } from 'react'
import { AppState } from 'react-native'
import { useFocusEffect } from 'expo-router'
import { sessionTabPaneKey } from '../../../../src/shared/remote-runtime/session-graph/session-tab-pane-key'
import { sendAgentActivity } from '../../agents/use-agent-activity-writes'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { ConnectionState } from '../../transport/connection/connection-state'
import type { MobileSessionTab } from './mobile-session-tabs'

/** Like the desktop's on-screen read: the active tab's unread agent is read while the screen is focused and the app is in front. */
export function useMarkViewedAgentRead(
  client: RpcClient | null,
  connState: ConnectionState,
  activeTab: MobileSessionTab | null | undefined
): void {
  const paneKey = sessionTabPaneKey(activeTab)
  const unread =
    (activeTab?.type === 'terminal' || activeTab?.type === 'agent-session') &&
    activeTab.unread === true
  useFocusEffect(
    useCallback(() => {
      if (!unread || !client || !paneKey || connState !== 'connected') {
        return
      }
      // One view of one unread turn: a new tab, focus, connection or turn starts a new one.
      let read = false
      let inFlight: AbortController | null = null
      const markRead = (): void => {
        if (read || inFlight || AppState.currentState !== 'active') {
          return
        }
        const attempt = new AbortController()
        inFlight = attempt
        // Never replayed after a reconnect or once the tab is out of view; a refusal waits for the next view.
        void sendAgentActivity(
          client,
          [paneKey],
          { unread: false },
          { signal: attempt.signal, failWhenDisconnected: true }
        )
          .then(
            () => {
              read = true
            },
            () => {}
          )
          .finally(() => {
            if (inFlight === attempt) {
              inFlight = null
            }
          })
      }
      const stopViewing = (): void => {
        inFlight?.abort()
        inFlight = null
      }
      markRead()
      const appStateSubscription = AppState.addEventListener('change', (state) =>
        state === 'active' ? markRead() : stopViewing()
      )
      return () => {
        appStateSubscription.remove()
        stopViewing()
      }
    }, [client, connState, paneKey, unread])
  )
}
