import { useCallback, useSyncExternalStore } from 'react'
import { nativeChatQueueFollowUps } from '../../../../../src/shared/native-chat/input/composer/native-chat-follow-up-behavior'
import type { RpcClient } from '../../../transport/rpc/rpc-client-contract'
import {
  mobileNativeChatHostPreference,
  QUEUE_FOLLOW_UPS_PREFERENCE
} from './mobile-native-chat-host-preference'

const defaultSnapshot = (): boolean => nativeChatQueueFollowUps(null)

export function useMobileNativeChatQueueFollowUps(
  client: RpcClient | null,
  connected: boolean,
  sessionId: string | null,
  pairedHostClient: RpcClient | null,
  active: boolean
): boolean {
  const preference = client
    ? mobileNativeChatHostPreference(client, QUEUE_FOLLOW_UPS_PREFERENCE)
    : null
  const pairedPreference = pairedHostClient
    ? mobileNativeChatHostPreference(pairedHostClient, QUEUE_FOLLOW_UPS_PREFERENCE)
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
