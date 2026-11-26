// A bot's soonest usage-limit stop in its workspaces, read from its host's status feed as the desktop's row reads it.
import { useCallback, useMemo, useSyncExternalStore } from 'react'
import type { NamedUsageLimitStop } from '../../../src/shared/bots/bot-usage-limit-stop'
import { hostUsageLimitStops } from '../../../src/shared/bots/host-usage-limit-stops'
import { mobileStructuredSessionStatusFeed } from '../session/native-chat/agent-session/mobile-structured-session-status-feed'
import { useRpcClientContext } from '../transport/connection/client-context'

const noSubscription = (): (() => void) => () => {}

/** `pairedHostId`: the paired computer whose feed lists the bot's sessions; null reads nothing.
 *  The host's stops are derived once for every row; each compares one string, so a stop elsewhere
 *  re-renders nothing. */
export function useMobileBotUsageLimitStop(
  pairedHostId: string | null,
  workspaceIds: readonly string[],
  now: number
): NamedUsageLimitStop | null {
  const clients = useRpcClientContext()
  const client = pairedHostId
    ? clients.getAllClients().find((entry) => entry.hostId === pairedHostId)?.client
    : undefined
  const stops = useMemo(
    () => (client ? hostUsageLimitStops(mobileStructuredSessionStatusFeed(client)) : null),
    [client]
  )
  const ids = workspaceIds.join('\n')
  const subscribe = useCallback(
    (listener: () => void) => (stops ? stops.subscribe(listener) : noSubscription()),
    [stops]
  )
  const read = useCallback(() => {
    const wanted = new Set(ids.split('\n'))
    const stop = stops?.stopsAt(now).find((s) => wanted.has(s.workspaceId))
    return stop ? JSON.stringify(stop) : ''
  }, [stops, ids, now])
  const key = useSyncExternalStore(subscribe, read, read)
  return useMemo(() => {
    if (!key) {
      return null
    }
    const stop: NamedUsageLimitStop = JSON.parse(key)
    return stop
  }, [key])
}
