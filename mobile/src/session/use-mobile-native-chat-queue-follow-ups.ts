import { useCallback, useSyncExternalStore } from 'react'
import { nativeChatQueueFollowUps } from '../../../src/shared/native-chat-follow-up-behavior'
import type { RpcClient } from '../transport/rpc-client'
import { mobileNativeChatFollowUpPreference } from './mobile-native-chat-follow-up-preference'

const defaultSnapshot = (): boolean => nativeChatQueueFollowUps(null)

export function useMobileNativeChatQueueFollowUps(
  client: RpcClient | null,
  connected: boolean,
  sessionId: string | null,
  pairedHostClient: RpcClient | null
): boolean {
  const preference = client ? mobileNativeChatFollowUpPreference(client) : null
  const pairedPreference = pairedHostClient
    ? mobileNativeChatFollowUpPreference(pairedHostClient)
    : null
  const subscribe = useCallback(
    (listener: () => void) => {
      const stops =
        connected && sessionId
          ? [...new Set([pairedPreference, preference])].flatMap((source) =>
              source ? [source.subscribe(listener)] : []
            )
          : []
      return () => {
        for (const stop of stops) {
          stop()
        }
      }
    },
    [pairedPreference, preference, connected, sessionId]
  )
  const getSnapshot = useCallback(
    () => pairedPreference?.getReportedSnapshot() ?? preference?.getSnapshot() ?? defaultSnapshot(),
    [pairedPreference, preference]
  )
  return useSyncExternalStore(subscribe, getSnapshot, defaultSnapshot)
}
