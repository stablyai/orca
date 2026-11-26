import { useCallback, useReducer, useSyncExternalStore } from 'react'
import type { MobileStructuredAgentSessionArgs } from '../../agent-session/mobile-structured-agent-session-contract'
import { structuredAgentSessionOptionStamp } from '../../../../../../src/shared/agent-session/options/reconciliation/structured-agent-session-option-state'
import { mobileStructuredSessionStatusFeed } from '../../agent-session/mobile-structured-session-status-feed'

const noSubscription = (): (() => void) => () => {}

/** Track other devices' picks and Antigravity command reports, even on compact mobile streams. */
export function useMobileStructuredSessionOptionStamp(
  args: Pick<
    MobileStructuredAgentSessionArgs,
    'agent' | 'client' | 'sessionId' | 'connected' | 'enabled' | 'onCommandsChanged' | 'hostSupport'
  >
) {
  const { agent, client, sessionId, connected, hostSupport, onCommandsChanged } = args
  const enabled = args.enabled && connected && hostSupport?.statusFeed === true
  const [revision, advanceRevision] = useReducer((value: number) => value + 1, 0)
  const commandOptionsChanged = useCallback(() => {
    onCommandsChanged?.()
    advanceRevision()
  }, [onCommandsChanged])
  const feed = enabled && client && sessionId ? mobileStructuredSessionStatusFeed(client) : null
  const subscribe = useCallback(
    (listener: () => void) => (feed ? feed.subscribe(listener) : noSubscription()),
    [feed]
  )
  const readStamp = (): string => {
    const summary = feed && sessionId ? feed.getSnapshot().get(sessionId) : undefined
    return JSON.stringify([structuredAgentSessionOptionStamp(summary), summary?.hostExecutionPhase])
  }
  const statusStamp = useSyncExternalStore(subscribe, readStamp, readStamp)
  return agent === 'antigravity'
    ? { optionStamp: `${statusStamp}:${revision}`, onCommandsChanged: commandOptionsChanged }
    : { optionStamp: statusStamp, onCommandsChanged }
}
