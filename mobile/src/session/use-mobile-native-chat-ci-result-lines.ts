import { useCallback, useSyncExternalStore } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import {
  CI_RESULT_LINES_PREFERENCE,
  mobileNativeChatHostPreference
} from './mobile-native-chat-host-preference'

const hidden = (): boolean => false

/** The paired desktop's last reported CI result lines setting; it records the lines, so no execution server answers for it. */
export function useMobileNativeChatCiResultLines(
  pairedHostClient: RpcClient | null,
  active: boolean
): boolean {
  const preference = pairedHostClient
    ? mobileNativeChatHostPreference(pairedHostClient, CI_RESULT_LINES_PREFERENCE)
    : null
  const subscribe = useCallback(
    (listener: () => void) => (preference && active ? preference.subscribe(listener) : () => {}),
    [preference, active]
  )
  return useSyncExternalStore(subscribe, preference?.getSnapshot ?? hidden, hidden)
}
