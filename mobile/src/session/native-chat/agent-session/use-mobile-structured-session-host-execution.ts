import { useCallback, useSyncExternalStore } from 'react'
import type { AgentSessionStatusSummary } from '../../../../../src/shared/agent-session/agent-session-wire'
import type { RpcClient } from '../../../transport/rpc/rpc-client-contract'
import { mobileStructuredSessionStatusFeed } from './mobile-structured-session-status-feed'

type HostExecutionArgs = {
  client: RpcClient | null
  sessionId: string | null
  enabled: boolean
}

const noSubscription = (): (() => void) => () => {}

// Only trust the host's report while its status-feed capability and transport are live.
function useHostSummaryValue<T>(
  { client, sessionId, enabled }: HostExecutionArgs,
  pick: (summary: AgentSessionStatusSummary | undefined) => T
): T {
  const feed = enabled && client && sessionId ? mobileStructuredSessionStatusFeed(client) : null
  const subscribe = useCallback(
    (listener: () => void) => (feed ? feed.subscribe(listener) : noSubscription()),
    [feed]
  )
  const read = (): T => pick(feed && sessionId ? feed.getSnapshot().get(sessionId) : undefined)
  return useSyncExternalStore(subscribe, read, read)
}

export function useMobileStructuredSessionHostStopping(args: HostExecutionArgs): boolean {
  return useHostSummaryValue(
    args,
    (summary) => summary?.status === 'working' && summary.stopping === true
  )
}

export function useMobileStructuredSessionHostExecutionPhase(
  args: HostExecutionArgs
): AgentSessionStatusSummary['hostExecutionPhase'] {
  return useHostSummaryValue(args, (summary) => summary?.hostExecutionPhase)
}
