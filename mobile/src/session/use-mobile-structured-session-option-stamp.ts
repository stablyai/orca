import { useCallback, useSyncExternalStore } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import { mobileStructuredSessionStatusFeed } from './mobile-structured-session-status-feed'

const noSubscription = (): (() => void) => () => {}

// Track other devices’ picks only while the host status feed is enabled.
export function useMobileStructuredSessionOptionStamp(args: {
  client: RpcClient | null
  sessionId: string | null
  enabled: boolean
}): string {
  const { client, sessionId, enabled } = args
  const feed = enabled && client && sessionId ? mobileStructuredSessionStatusFeed(client) : null
  const subscribe = useCallback(
    (listener: () => void) => (feed ? feed.subscribe(listener) : noSubscription()),
    [feed]
  )
  const readStamp = (): string => {
    const summary = feed && sessionId ? feed.getSnapshot().get(sessionId) : undefined
    return `${summary?.model ?? ''}|${summary?.permissionMode ?? ''}`
  }
  return useSyncExternalStore(subscribe, readStamp, readStamp)
}
