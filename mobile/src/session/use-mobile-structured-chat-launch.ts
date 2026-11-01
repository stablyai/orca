import { useEffect, useSyncExternalStore } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import {
  loadMobileStructuredChatLaunchContext,
  readMobileStructuredChatLaunchContext,
  subscribeMobileStructuredChatLaunch,
  type MobileStructuredChatLaunchContext
} from './mobile-structured-chat-launch'

export function useMobileStructuredChatLaunch(
  client: RpcClient | null,
  hostCapabilities: readonly string[] | null | undefined
): MobileStructuredChatLaunchContext | null {
  const context = useSyncExternalStore(
    subscribeMobileStructuredChatLaunch,
    readMobileStructuredChatLaunchContext,
    () => null
  )
  useEffect(() => {
    if (!client) {
      return
    }
    void loadMobileStructuredChatLaunchContext({ client, hostCapabilities })
  }, [client, hostCapabilities])
  return context
}
