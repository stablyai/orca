import { useMemo, useSyncExternalStore } from 'react'
import type { RpcClient } from '../../../../transport/rpc/rpc-client-contract'
import { mobileStructuredSessionStatusFeed } from '../../agent-session/mobile-structured-session-status-feed'

const missing = () => undefined
const noSubscription = () => () => {}

export function useMobileChatProviderPicker(
  client: RpcClient | null,
  sessionId: string | null,
  worktreeId: string,
  hostId: string
) {
  const feed = useMemo(
    () => (client && sessionId ? mobileStructuredSessionStatusFeed(client) : null),
    [client, sessionId]
  )
  const selection = useSyncExternalStore(
    feed?.subscribe ?? noSubscription,
    () => (sessionId ? feed?.getSnapshot().get(sessionId)?.selectedProvider : undefined),
    missing
  )
  const active = useSyncExternalStore(
    feed?.subscribe ?? noSubscription,
    () => (sessionId ? feed?.getSnapshot().get(sessionId)?.agent : undefined),
    missing
  )
  return useMemo(
    () =>
      client && sessionId ? { client, sessionId, worktreeId, hostId, selection, active } : null,
    [client, sessionId, worktreeId, hostId, selection, active]
  )
}

export type MobileChatProviderPickerScope = NonNullable<
  ReturnType<typeof useMobileChatProviderPicker>
>
