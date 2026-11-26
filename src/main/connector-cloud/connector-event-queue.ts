import {
  CONNECTOR_CLIENT_LIMITS,
  type ConnectorEvent
} from '../../shared/connectors/connector-cloud-contract'
import { jsonBytes } from './connector-snapshot'

const MAX_TURN_ENDS = 200
// Live events past this are dropped oldest first; a fresh hello and snapshot then restate them.
const MAX_LIVE_EVENTS = 500
// Room for the request's own fields around its events.
const EVENTS_BUDGET_BYTES = CONNECTOR_CLIENT_LIMITS.maxRequestBytes - 1024

type TurnEnded = Extract<ConnectorEvent, { kind: 'turn-ended' }>

export const isTurnEnded = (event: ConnectorEvent): event is TurnEnded =>
  event.kind === 'turn-ended'
// Reply events are the journal's rows in transit: never trimmed, never stored here.
const isLive = (event: ConnectorEvent): boolean =>
  event.kind !== 'turn-ended' && event.kind !== 'snapshot' && event.kind !== 'reply'

/** As many leading events as fit in one request, and at least one. */
export function eventsHeadSize(events: readonly ConnectorEvent[]): number {
  let bytes = 0
  for (const [index, event] of events.entries()) {
    bytes += jsonBytes(event) + 1
    if (bytes > EVENTS_BUDGET_BYTES) {
      return Math.max(1, index)
    }
  }
  return events.length
}

/** Only a pane's newest unsent activity is worth sending: each one replaces the last in the thread. */
export function newestActivities(events: ConnectorEvent[], sent: number): ConnectorEvent[] {
  const newest = new Map<string, number>()
  events.forEach((event, index) => {
    if (event.kind === 'activity') {
      newest.set(event.paneKey, index)
    }
  })
  return newest.size === 0
    ? events
    : events.filter(
        (event, index) =>
          index < sent || event.kind !== 'activity' || newest.get(event.paneKey) === index
      )
}

/**
 * Keeps the newest turn ends and live events within their caps, never trimming the first `sent`, so memory
 * and disk hold the same set. A snapshot is never dropped: it opens its hello.
 */
export function boundEvents(events: ConnectorEvent[], sent: number): ConnectorEvent[] {
  let turnEndsOver = events.filter(isTurnEnded).length - MAX_TURN_ENDS
  let liveOver = events.filter(isLive).length - MAX_LIVE_EVENTS
  if (turnEndsOver <= 0 && liveOver <= 0) {
    return events
  }
  return events.filter(
    (event, index) =>
      index < sent || (isTurnEnded(event) ? turnEndsOver-- <= 0 : !isLive(event) || liveOver-- <= 0)
  )
}
