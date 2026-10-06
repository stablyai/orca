import { useCallback, useSyncExternalStore } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import { mobileStructuredSessionStatusFeed } from './mobile-structured-session-status-feed'

const noSubscription = (): (() => void) => () => {}

/**
 * Whether the host says a person's Stop is ending session `sessionId`'s turn: the same status
 * stream and field the desktop chat reads. `enabled` carries the host's status-feed capability
 * and a live connection; off it, nothing is opened and nothing reads as stopping.
 */
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
