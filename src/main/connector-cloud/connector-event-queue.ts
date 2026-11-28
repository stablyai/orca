import {
  CONNECTOR_CLIENT_LIMITS,
  CONNECTOR_REPLIES_OUTBOX_FEATURE,
  type ConnectorEvent
} from '../../shared/connectors/connector-cloud-contract'
import {
  CONNECTOR_SLACK_PRESENTATION_FEATURE,
  CONNECTOR_SLACK_PRESENTATION_TEXT_FEATURE,
  CONNECTOR_SLACK_PRESENTATION_TURN_END_FEATURE
} from '../../shared/connectors/slack-answer-presentation'
import { jsonBytes } from './connector-snapshot'
import type { ConnectorFailure } from './connector-cloud-request'
import { parkPreparedAnswer } from './connector-outbox'

const MAX_TURN_ENDS = 200
// Live events past this are dropped oldest first; a fresh hello and snapshot then restate them.
const MAX_LIVE_EVENTS = 500
// Room for the request's own fields around its events.
const EVENTS_BUDGET_BYTES = CONNECTOR_CLIENT_LIMITS.maxRequestBytes - 1024

export function presentationTransportChanged(
  before: ReadonlySet<string>,
  after: ReadonlySet<string>
): boolean {
  return [
    CONNECTOR_SLACK_PRESENTATION_FEATURE,
    CONNECTOR_SLACK_PRESENTATION_TEXT_FEATURE,
    CONNECTOR_SLACK_PRESENTATION_TURN_END_FEATURE,
    CONNECTOR_REPLIES_OUTBOX_FEATURE
  ].some((feature) => before.has(feature) !== after.has(feature))
}

export function reportedTurnEnds(events: readonly ConnectorEvent[]): ConnectorEvent[] {
  return events.filter((event) => !('preparedStateOnly' in event))
}

type TurnEnded = Extract<ConnectorEvent, { kind: 'turn-ended' }>

export const isTurnEnded = (event: ConnectorEvent): event is TurnEnded =>
  event.kind === 'turn-ended'
export const isPreparedTurnEnd = (
  event: ConnectorEvent
): event is TurnEnded & {
  presentation: NonNullable<TurnEnded['presentation']>
} => isTurnEnded(event) && event.presentation !== undefined

export function deferPreparedTurnEnd(event: ConnectorEvent, failure?: ConnectorFailure) {
  if (!isPreparedTurnEnd(event)) {
    return undefined
  }
  const untilChange = parkPreparedAnswer(failure)
  if (failure?.status === 413) {
    console.warn('[connector] a prepared Slack answer exceeds the receiver limit and remains owed')
  }
  if ('stateOnlyQueued' in event) {
    return { answer: event, untilChange }
  }
  const { lastAssistantMessage: _words, presentation: _body, links: _links, ...state } = event
  return {
    answer: { ...event, stateOnlyQueued: true },
    stateOnly: { ...state, stateOnly: true as const, preparedStateOnly: true },
    untilChange
  }
}
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
  let turnEndsOver =
    events.filter((event) => isTurnEnded(event) && !isPreparedTurnEnd(event)).length - MAX_TURN_ENDS
  let liveOver = events.filter(isLive).length - MAX_LIVE_EVENTS
  if (turnEndsOver <= 0 && liveOver <= 0) {
    return events
  }
  return events.filter(
    (event, index) =>
      index < sent ||
      isPreparedTurnEnd(event) ||
      (isTurnEnded(event) ? turnEndsOver-- <= 0 : !isLive(event) || liveOver-- <= 0)
  )
}
