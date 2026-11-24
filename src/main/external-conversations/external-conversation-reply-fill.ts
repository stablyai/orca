import type { AgentJournalTurnOutcome } from '../../shared/agent-status/lifecycle/agent-turn-outcome'
import {
  JOURNAL_CONNECTOR_REPLY_PROSE_BYTES,
  type JournalConnectorReplyFill,
  type JournalConnectorReplyRow
} from '../../shared/agent-session/journal/journal-connector-reply'
import {
  connectorReplyTurnOutcome,
  type ConnectorReplyStamp
} from '../../shared/agent-session/journal/journal-connector-reply-turn'
import type { ConnectorFailure } from '../../shared/connectors/connector-cloud-contract'
import type { ConnectorWorkLink } from '../../shared/connector-work-link-contract'
import type { ConnectorReplyJournal } from '../connector-cloud/connector-reply-outbox'
import { capAnswer } from '../connector-cloud/connector-snapshot'
import type { AgentSessionJournalReads } from '../native-chat/agent-session-journal/journal-reads'
import { isQuietBotResult } from '../../shared/bot-quiet-result'
import { isSlackDirectMessage } from '../../shared/connectors/slack-direct-message'
import { agentJournalSubmissionKey } from '../../shared/agent-session/journal/agent-session-journal-item-key'

export type EndedTurnReplies = {
  sessionId: string
  turnItemId: string
  /** The deliveries the turn answered, opener first (connectorReplyTurnStamps). */
  stamps: readonly ConnectorReplyStamp[]
  /** The turn's opening message: a continuation fills only the rows its admission claimed. */
  openerItemId?: string
  outcome: AgentJournalTurnOutcome
  prose: string
  bot: boolean
  failure?: ConnectorFailure
  links: ConnectorWorkLink[]
  /** How long the turn ran; absent when its start predates this watch. */
  tookMs?: number
  /** The turn's turn-started `at` as its conversation knows it; absent after a restart. */
  turnStartedAt?: number
}

/** What a fill did: the conversations its rows cover, and whether a usage-limit pause cut them
 *  for an automatic continue instead (Phase 1 §1.5), with when it is due, if the app shows a time. */
export type FilledTurn = {
  covered: ReadonlySet<string>
  paused: boolean
  resumesAt?: number
}

/** Whether the bot's owner sent the message that admitted a row (its journal body's asker): the
 *  owner proof of an older build's row a continuation claimed, whose own stamps carry none. */
export type AskedByOwner = (sessionId: string, messageId: string) => Promise<boolean>

/** AskedByOwner over a chat's journal: the asker of the send that admitted the row, or, for a
 *  queued card's row (whose id is the card's), of the send the card was handed over as. */
export function journalAskedByOwner(
  reads: (
    sessionId: string
  ) => Promise<Pick<AgentSessionJournalReads, 'submissionBody'> | undefined>
): AskedByOwner {
  return async (sessionId, messageId) => {
    const body = await (await reads(sessionId))?.submissionBody(messageId, { family: true })
    return body?.asker?.role === 'owner'
  }
}

/** Fills an ended turn's outbox rows (design item 125 §3), the first fill winning. */
export type ConversationReplyFill = (turn: EndedTurnReplies) => Promise<FilledTurn>

/** Cuts a usage-limit turn's own rows when its continue is pending; false fills them as failed. */
export type UsageLimitPause = (
  turn: EndedTurnReplies,
  rows: readonly JournalConnectorReplyRow[]
) => Promise<false | { resumesAt?: number }>

const keyOf = (account: string, deliveryId: string): string => `${account}\0${deliveryId}`

/**
 * Takes the session's rows the turn's stamps name and fills the unfilled ones. Returns the
 * conversations (external ids) those rows cover: their answer goes through the outbox, never the
 * legacy turn end.
 */
export function conversationReplyFill(
  journal: () => ConnectorReplyJournal | null,
  filled: () => void,
  pause?: UsageLimitPause,
  askedByOwner?: AskedByOwner
): ConversationReplyFill {
  return async (turn) => {
    const store = journal()
    if (!store || turn.stamps.length === 0) {
      return { covered: new Set(), paused: false }
    }
    const order = new Map<string, number>()
    const ownerAsked = new Set<string>()
    for (const stamp of turn.stamps) {
      for (const deliveryId of [stamp.deliveryId, ...(stamp.carried ?? [])]) {
        const key = keyOf(stamp.account, deliveryId)
        if (!order.has(key)) {
          order.set(key, order.size)
        }
        if (stamp.ownerAsked) {
          ownerAsked.add(key)
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
    // The group's head keys its answer: its earliest stamp per conversation, filled or sent or not,
    // so a partial fill or a deleted row never moves the key.
    const answers = new Map<string, string>()
    for (const stamp of turn.stamps) {
      const conversation = JSON.stringify([stamp.account, stamp.conversation])
      if (!answers.has(conversation)) {
        answers.set(conversation, stamp.deliveryId)
      }
    }
    const covered = new Set(rows.map((row) => row.conversation.externalId))
    // A row a continuation claimed is that continuation's turn's to fill; one a cut still owes is
    // its continuation's or its close's.
    const claimedHere = (row: JournalConnectorReplyRow) =>
      row.claimMessageId !== undefined &&
      agentJournalSubmissionKey(row.claimMessageId) === turn.openerItemId
    const own = rows.filter(
      (row) => !row.fill && (claimedHere(row) || (row.claimMessageId === undefined && !row.cut))
    )
    const paused =
      turn.outcome === 'failure' && turn.failure?.category === 'usage_limit' && own.length > 0
        ? await pause?.(turn, own)
        : false
    if (paused) {
      return { covered, paused: true, ...paused }
    }
    // One answer per conversation, under the rule its turn began with: its head's (its earliest row
    // still kept, filled or not). A row an older build admitted silences the whole reply, except to
    // its owner in their own DM.
    const markerMayQuiet = turn.bot && turn.outcome === 'success' && isQuietBotResult(turn.prose)
    const filling = new Set(own.map((row) => JSON.stringify([row.account, row.conversation])))
    const silencedWhole = new Map<string, boolean>()
    for (const row of markerMayQuiet ? rows : []) {
      const conversation = JSON.stringify([row.account, row.conversation])
      if (!filling.has(conversation) || silencedWhole.has(conversation)) {
        continue
      }
      const ownerDm =
        row.quietRule === undefined &&
        isSlackDirectMessage(row.conversation) &&
        (ownerAsked.has(keyOf(row.account, row.deliveryId)) ||
          (await askedByOwner?.(turn.sessionId, row.messageId).catch(() => false)) === true)
      silencedWhole.set(conversation, row.quietRule === undefined && !ownerDm)
    }
    const fills: JournalConnectorReplyFill[] = []
    for (const row of own) {
      const conversation = JSON.stringify([row.account, row.conversation])
      const { outcome, prose } = connectorReplyTurnOutcome({
        ...turn,
        silencedWhole: silencedWhole.get(conversation) === true
      })
      const answerDeliveryId = answers.get(conversation) ?? row.deliveryId
      fills.push({
        account: row.account,
        deliveryId: row.deliveryId,
        ...(claimedHere(row) ? { expect: { claimMessageId: row.claimMessageId! } } : {}),
        outcome,
        answerDeliveryId,
        turnItemId: turn.turnItemId,
        ...(prose ? { prose: capAnswer(prose, JOURNAL_CONNECTOR_REPLY_PROSE_BYTES) } : {}),
        ...(outcome === 'failed' && turn.failure ? { failure: turn.failure } : {}),
        ...(turn.links.length > 0 ? { links: turn.links } : {}),
        ...(outcome === 'answered' && turn.tookMs !== undefined ? { tookMs: turn.tookMs } : {}),
        ...(turn.turnStartedAt === undefined ? {} : { turnStartedAt: turn.turnStartedAt })
      })
    }
    if (await store.fillOutcomes(fills)) {
      filled()
    }
    return { covered, paused: false }
  }
}
