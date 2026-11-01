import { useCallback, useSyncExternalStore } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import { mobileStructuredSessionStatusFeed } from './mobile-structured-session-status-feed'

const noSubscription = (): (() => void) => () => {}

// Only trust host Stopping while its status-feed capability and transport are live.
export function useMobileStructuredSessionHostStopping(args: {
  client: RpcClient | null
  sessionId: string | null
  enabled: boolean
}): boolean {
  const { client, sessionId, enabled } = args
  const feed = enabled && client && sessionId ? mobileStructuredSessionStatusFeed(client) : null
  const subscribe = useCallback(
    (listener: () => void) => (feed ? feed.subscribe(listener) : noSubscription()),
    [feed]
  )
  const readStopping = (): boolean => {
    const summary = feed && sessionId ? feed.getSnapshot().get(sessionId) : undefined
    return summary?.status === 'working' && summary.stopping === true
  }
  return useSyncExternalStore(subscribe, readStopping, readStopping)
}
