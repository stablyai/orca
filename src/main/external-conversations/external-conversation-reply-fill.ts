import type { AgentJournalTurnOutcome } from '../../shared/agent-status/lifecycle/agent-turn-outcome'
import type { AgentJournalConnectorDelivery } from '../../shared/agent-session/journal/agent-journal-bot-message-fields'
import {
  JOURNAL_CONNECTOR_REPLY_PROSE_BYTES,
  type JournalConnectorReplyFill
} from '../../shared/agent-session/journal/journal-connector-reply'
import { connectorReplyTurnOutcome } from '../../shared/agent-session/journal/journal-connector-reply-turn'
import type { ConnectorFailure } from '../../shared/connectors/connector-cloud-contract'
import type { ConnectorWorkLink } from '../../shared/connector-work-link-contract'
import type { ConnectorReplyJournal } from '../connector-cloud/connector-reply-outbox'
import { capUtf8 } from '../connector-cloud/connector-snapshot'

export type EndedTurnReplies = {
  sessionId: string
  turnItemId: string
  /** The deliveries the turn answered, opener first (connectorReplyTurnStamps). */
  stamps: readonly AgentJournalConnectorDelivery[]
  outcome: AgentJournalTurnOutcome
  prose: string
  bot: boolean
  failure?: ConnectorFailure
  links: ConnectorWorkLink[]
}

/** Fills an ended turn's outbox rows (design item 125 §3), the first fill winning. */
export type ConversationReplyFill = (turn: EndedTurnReplies) => Promise<ReadonlySet<string>>

const keyOf = (account: string, deliveryId: string): string => `${account}\0${deliveryId}`

/**
 * Takes the session's rows the turn's stamps name and fills the unfilled ones. Returns the
 * conversations (external ids) those rows cover: their answer goes through the outbox, never the
 * legacy turn end.
 */
export function conversationReplyFill(
  journal: () => ConnectorReplyJournal | null,
  filled: () => void
): ConversationReplyFill {
  return async (turn) => {
    const store = journal()
    if (!store || turn.stamps.length === 0) {
      return new Set()
    }
    const order = new Map<string, number>()
    for (const stamp of turn.stamps) {
      for (const deliveryId of [stamp.deliveryId, ...(stamp.carried ?? [])]) {
        const key = keyOf(stamp.account, deliveryId)
        if (!order.has(key)) {
          order.set(key, order.size)
        }
      }
    }
    const rows = (await store.read(turn.sessionId))
      .filter((row) => order.has(keyOf(row.account, row.deliveryId)))
      .sort(
        (a, b) =>
          (order.get(keyOf(a.account, a.deliveryId)) ?? 0) -
          (order.get(keyOf(b.account, b.deliveryId)) ?? 0)
      )
    const { outcome, prose } = connectorReplyTurnOutcome({
      outcome: turn.outcome,
      prose: turn.prose,
      bot: turn.bot
    })
    // The earliest unfilled row per conversation keys the answer.
    const answers = new Map<string, string>()
    const fills: JournalConnectorReplyFill[] = []
    for (const row of rows.filter((candidate) => !candidate.fill)) {
      const conversation = JSON.stringify([row.account, row.conversation])
      const answerDeliveryId = answers.get(conversation) ?? row.deliveryId
      answers.set(conversation, answerDeliveryId)
      fills.push({
        account: row.account,
        deliveryId: row.deliveryId,
        outcome,
        answerDeliveryId,
        turnItemId: turn.turnItemId,
        ...(prose ? { prose: capUtf8(prose, JOURNAL_CONNECTOR_REPLY_PROSE_BYTES) } : {}),
        ...(outcome === 'failed' && turn.failure ? { failure: turn.failure } : {}),
        ...(turn.links.length > 0 ? { links: turn.links } : {})
      })
    }
    if (await store.fillOutcomes(fills)) {
      filled()
    }
    return new Set(rows.map((row) => row.conversation.externalId))
  }
}
