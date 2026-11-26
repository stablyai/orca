import {
  CONNECTOR_CLIENT_LIMITS,
  cloudConversation,
  type ConnectorEvent
} from '../../shared/connectors/connector-cloud-contract'
import type { JournalConnectorReplyRow } from '../../shared/agent-session/journal/journal-connector-reply'
import { slackAnswerText } from '../../shared/connectors/slack-answer-presentation'

export type ConnectorReplyEvent = Extract<ConnectorEvent, { kind: 'reply' }>

export const isReplyEvent = (event: ConnectorEvent): event is ConnectorReplyEvent =>
  event.kind === 'reply'

export const replyDeliveryIds = (events: readonly ConnectorEvent[]): string[] =>
  events.filter(isReplyEvent).flatMap((event) => event.deliveryIds)

export type FilledConnectorReply = JournalConnectorReplyRow & {
  fill: NonNullable<JournalConnectorReplyRow['fill']>
}

/** One event per conversation and answer, at most the contract's ids each. */
export function replyEventsOf(rows: readonly FilledConnectorReply[]): ConnectorReplyEvent[] {
  const groups = new Map<string, FilledConnectorReply[]>()
  for (const row of rows) {
    const key = JSON.stringify([
      row.conversation,
      row.fill.answerDeliveryId,
      row.fill.outcome,
      row.fill.turnStartedAt,
      row.fill.toolsRan
    ])
    groups.set(key, [...(groups.get(key) ?? []), row])
  }
  const events: ConnectorReplyEvent[] = []
  for (const group of groups.values()) {
    const [first] = group
    const conversation = first && cloudConversation(first.conversation)
    if (!first || !conversation) {
      continue
    }
    const {
      answerDeliveryId,
      outcome,
      prose,
      presentation,
      failure,
      links,
      tookMs,
      turnStartedAt,
      toolsRan
    } = first.fill
    // Each event names the answer's own delivery among its ids.
    const others = group.map((row) => row.deliveryId).filter((id) => id !== answerDeliveryId)
    const room = CONNECTOR_CLIENT_LIMITS.maxReplyDeliveryIds - 1
    for (let start = 0; start === 0 || start < others.length; start += room) {
      events.push({
        kind: 'reply',
        conversation,
        deliveryIds: [answerDeliveryId, ...others.slice(start, start + room)],
        answerDeliveryId,
        outcome,
        ...(outcome === 'answered' && prose
          ? { prose: presentation ? slackAnswerText(presentation) : prose }
          : {}),
        ...(outcome === 'answered' && conversation.source === 'slack' && presentation
          ? { presentation }
          : {}),
        ...(failure ? { failure } : {}),
        ...(links?.length ? { links } : {}),
        ...(outcome === 'answered' && tookMs ? { tookMs } : {}),
        ...(turnStartedAt === undefined ? {} : { turnId: turnStartedAt }),
        ...(outcome === 'no_answer' && toolsRan ? { toolsRan } : {})
      })
    }
  }
  return events
}
