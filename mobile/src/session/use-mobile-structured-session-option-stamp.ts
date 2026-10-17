import { useCallback, useSyncExternalStore } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import { mobileStructuredSessionStatusFeed } from './mobile-structured-session-status-feed'

const noSubscription = (): (() => void) => () => {}

/** Options and process readiness share a stamp; disabled panes never subscribe. */
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
    return `${summary?.model ?? ''}|${summary?.permissionMode ?? ''}|${summary?.hostExecutionPhase ?? ''}`
  }
  return useSyncExternalStore(subscribe, readStamp, readStamp)
}
