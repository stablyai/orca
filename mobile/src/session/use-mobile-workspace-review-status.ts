import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { AppState } from 'react-native'
import { useFocusEffect } from 'expo-router'
import type { RpcClient } from '../transport/rpc-client'
import { createMobileWorkspaceReviewStatus } from './mobile-workspace-review-status'

export function useMobileWorkspaceReviewStatus({
  client,
  worktreeId,
  enabled,
  supported
}: {
  client: RpcClient | null
  worktreeId: string
  enabled: boolean
  supported: boolean
}) {
  const status = useMemo(() => createMobileWorkspaceReviewStatus(), [client, worktreeId])
  useFocusEffect(
    useCallback(() => {
      if (!enabled || !client) {
        return
      }
      let release = () => {}
      let running = false
      let foreground = AppState.currentState === 'active'
      const reconcile = () => {
        const ready = foreground && client.getState() === 'connected'
        if (ready === running) {
          return
        }
        running = ready
        release()
        release = ready ? status.start(client, worktreeId, supported) : () => {}
        if (!ready) {
          status.reset()
        }
      }
      const appState = AppState.addEventListener('change', (state) => {
        foreground = state === 'active'
        reconcile()
      })
      const connection = client.onStateChange(reconcile)
      reconcile()
      return () => {
        appState.remove()
        connection()
        release()
        status.reset()
      }
    }, [client, worktreeId, enabled, supported, status])
  )
  return useSyncExternalStore(status.subscribe, status.getSnapshot, status.getSnapshot)
}
