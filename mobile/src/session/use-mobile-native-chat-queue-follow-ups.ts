import { useCallback, useSyncExternalStore } from 'react'
import { nativeChatQueueFollowUps } from '../../../src/shared/native-chat-follow-up-behavior'
import type { RpcClient } from '../transport/rpc-client'
import { mobileNativeChatFollowUpPreference } from './mobile-native-chat-follow-up-preference'

const defaultSnapshot = (): boolean => nativeChatQueueFollowUps(null)

export function useMobileNativeChatQueueFollowUps(
  client: RpcClient | null,
  connected: boolean,
  sessionId: string | null,
  pairedHostClient: RpcClient | null,
  active: boolean
): boolean {
  const preference = client ? mobileNativeChatFollowUpPreference(client) : null
  const pairedPreference = pairedHostClient
    ? mobileNativeChatFollowUpPreference(pairedHostClient)
    : null
  // The paired host's stream outlives an execution-server outage; the projection follows its own connection.
  const subscribePaired = useCallback(
    (listener: () => void) =>
      pairedPreference && active && sessionId ? pairedPreference.subscribe(listener) : () => {},
    [pairedPreference, active, sessionId]
  )
  const subscribe = useCallback(
    (listener: () => void) =>
      preference && connected && sessionId ? preference.subscribe(listener) : () => {},
    [preference, connected, sessionId]
  )
  const getSnapshot = useCallback(
    () => pairedPreference?.getReportedSnapshot() ?? preference?.getSnapshot() ?? defaultSnapshot(),
    [pairedPreference, preference]
  )
  // Both stores read the combined value, so only a change to what Send uses re-renders.
  useSyncExternalStore(subscribePaired, getSnapshot, defaultSnapshot)
  return useSyncExternalStore(subscribe, getSnapshot, defaultSnapshot)
}
