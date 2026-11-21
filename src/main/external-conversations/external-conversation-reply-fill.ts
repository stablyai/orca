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
import { capAnswer } from '../connector-cloud/connector-snapshot'
import { agentJournalSubmissionKey } from '../../shared/agent-session/journal/agent-session-journal-item-key'

export type EndedTurnReplies = {
  sessionId: string
  turnItemId: string
  /** The deliveries the turn answered, opener first (connectorReplyTurnStamps). */
  stamps: readonly AgentJournalConnectorDelivery[]
  /** The turn's opening message: a continuation fills only the rows its admission claimed. */
  openerItemId?: string
  outcome: AgentJournalTurnOutcome
  prose: string
  bot: boolean
  failure?: ConnectorFailure
  links: ConnectorWorkLink[]
  /** How long the turn ran; absent when its start predates this watch. */
  tookMs?: number
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
    // The group's head keys its answer: its earliest stamp per conversation, filled or sent or not,
    // so a partial fill or a deleted row never moves the key.
    const answers = new Map<string, string>()
    for (const stamp of turn.stamps) {
      const conversation = JSON.stringify([stamp.account, stamp.conversation])
      if (!answers.has(conversation)) {
        answers.set(conversation, stamp.deliveryId)
      }
    }
    const fills: JournalConnectorReplyFill[] = []
    for (const row of rows.filter((candidate) => !candidate.fill)) {
      // A row a continuation claimed is that continuation's turn's to fill; one a cut still owes is
      // its continuation's or its close's.
      const claimedHere =
        row.claimMessageId !== undefined &&
        agentJournalSubmissionKey(row.claimMessageId) === turn.openerItemId
      if ((row.claimMessageId !== undefined && !claimedHere) || (!claimedHere && row.cut)) {
        continue
      }
      const conversation = JSON.stringify([row.account, row.conversation])
      const answerDeliveryId = answers.get(conversation) ?? row.deliveryId
      fills.push({
        account: row.account,
        deliveryId: row.deliveryId,
        ...(claimedHere ? { expect: { claimMessageId: row.claimMessageId! } } : {}),
        outcome,
        answerDeliveryId,
        turnItemId: turn.turnItemId,
        ...(prose ? { prose: capAnswer(prose, JOURNAL_CONNECTOR_REPLY_PROSE_BYTES) } : {}),
        ...(outcome === 'failed' && turn.failure ? { failure: turn.failure } : {}),
        ...(turn.links.length > 0 ? { links: turn.links } : {}),
        ...(outcome === 'answered' && turn.tookMs !== undefined ? { tookMs: turn.tookMs } : {})
      })
    }
    if (await store.fillOutcomes(fills)) {
      filled()
    }
    return new Set(rows.map((row) => row.conversation.externalId))
  }
}
