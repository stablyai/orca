import { createHash } from 'node:crypto'
import {
  CONNECTOR_CLIENT_LIMITS,
  cloudConversation,
  type ConnectorEvent
} from '../../shared/connectors/connector-cloud-contract'
import {
  JOURNAL_CONNECTOR_REPLY_PROSE_BYTES,
  type JournalConnectorReplyRow
} from '../../shared/agent-session/journal/journal-connector-reply'
import { slackAnswerText } from '../../shared/connectors/slack-answer-presentation'
import { outcomeSentence } from './connector-reply-outcome-sentence'
import type { ConnectorReplyBody } from './connector-replies'
import { capAnswer } from './connector-snapshot'

export type ConnectorReplyEvent = Extract<ConnectorEvent, { kind: 'reply' }>

export const isReplyEvent = (event: ConnectorEvent): event is ConnectorReplyEvent =>
  event.kind === 'reply'

export const replyDeliveryIds = (events: readonly ConnectorEvent[]): string[] =>
  events.filter(isReplyEvent).flatMap((event) => event.deliveryIds)

export type FilledConnectorReply = JournalConnectorReplyRow & {
  fill: NonNullable<JournalConnectorReplyRow['fill']>
}

// Older builds could store an answer longer than the current event's cap.
export const fitReplyProse = (row: FilledConnectorReply): FilledConnectorReply =>
  row.fill.prose === undefined
    ? row
    : {
        ...row,
        fill: { ...row.fill, prose: capAnswer(row.fill.prose, JOURNAL_CONNECTOR_REPLY_PROSE_BYTES) }
      }

/** The kill-switch drain keeps the same reply id across retries. */
export function drainReplyId(deliveryId: string): string {
  return `outcome-${createHash('sha256').update(deliveryId).digest('base64url')}`
}

export function drainReplyBody(
  row: FilledConnectorReply,
  conversation: ConnectorReplyBody['conversation'],
  hostName: () => string
): ConnectorReplyBody {
  const { outcome, prose, presentation, answerDeliveryId, filledAt, turnStartedAt, toolsRan } =
    row.fill
  return {
    replyId: drainReplyId(row.deliveryId),
    conversation,
    answerDeliveryId,
    turnId: turnStartedAt ?? filledAt,
    ...(presentation
      ? { text: slackAnswerText(presentation), presentation }
      : {
          text:
            outcome === 'answered' && prose ? prose : outcomeSentence(outcome, hostName(), toolsRan)
        })
  }
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
    const previous = groups.get(key)
    if (previous) {
      previous.push(row)
    } else {
      groups.set(key, [row])
    }
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
    const answer = presentation ? slackAnswerText(presentation) : prose
    for (let start = 0; start === 0 || start < others.length; start += room) {
      events.push({
        kind: 'reply',
        conversation,
        deliveryIds: [answerDeliveryId, ...others.slice(start, start + room)],
        answerDeliveryId,
        outcome,
        ...(outcome === 'answered' && answer ? { prose: answer } : {}),
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
