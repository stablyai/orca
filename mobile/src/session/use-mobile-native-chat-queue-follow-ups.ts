import { useCallback, useSyncExternalStore } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import { mobileNativeChatFollowUpPreference } from './mobile-native-chat-follow-up-preference'

const defaultSnapshot = (): boolean => false

export function useMobileNativeChatQueueFollowUps(
  client: RpcClient | null,
  connected: boolean,
  sessionId: string | null
): boolean {
  const preference = client ? mobileNativeChatFollowUpPreference(client) : null
  const subscribe = useCallback(
    (listener: () => void) =>
      preference && connected && sessionId ? preference.subscribe(listener) : () => {},
    [preference, connected, sessionId]
  )
  return useSyncExternalStore(
    subscribe,
    preference?.getSnapshot ?? defaultSnapshot,
    defaultSnapshot
  )
}
