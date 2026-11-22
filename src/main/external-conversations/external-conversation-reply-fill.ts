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
}

/** What a fill did: the conversations its rows cover, and whether a usage-limit pause cut them
 *  for an automatic continue instead (Phase 1 §1.5), with when it is due, if the app shows a time.
 *  `answered`: those its rows answer with words, so nothing there needs a stand-in reply. */
export type FilledTurn = {
  covered: ReadonlySet<string>
  paused: boolean
  resumesAt?: number
  answered?: ReadonlySet<string>
}

/** Fills an ended turn's outbox rows (design item 125 §3), the first fill winning. */
export type ConversationReplyFill = (turn: EndedTurnReplies) => Promise<FilledTurn>

/** Cuts a usage-limit turn's own rows when its continue is pending; false fills them as failed. */
export type UsageLimitPause = (
  turn: EndedTurnReplies,
  rows: readonly JournalConnectorReplyRow[]
) => Promise<false | { resumesAt?: number }>

const ANSWERED_TURNS_KEPT = 64

const keyOf = (account: string, deliveryId: string): string => `${account}\0${deliveryId}`

/**
 * Takes the session's rows the turn's stamps name and fills the unfilled ones. Returns the
 * conversations (external ids) those rows cover: their answer goes through the outbox, never the
 * legacy turn end.
 */
export function conversationReplyFill(
  journal: () => ConnectorReplyJournal | null,
  filled: () => void,
  pause?: UsageLimitPause
): ConversationReplyFill {
  // The conversations each recent turn answered with words. Recovery and the live end fill through
  // this one function, and a sent row is deleted, so the live end of a turn recovery already
  // answered still knows (its rows may be gone by then). In memory, bounded: one process's turns.
  const answeredByTurn = new Map<string, ReadonlySet<string>>()
  const remember = (key: string, answered: ReadonlySet<string>) => {
    answeredByTurn.delete(key)
    answeredByTurn.set(key, answered)
    for (const oldest of answeredByTurn.keys()) {
      if (answeredByTurn.size <= ANSWERED_TURNS_KEPT) {
        break
      }
      answeredByTurn.delete(oldest)
    }
  }
  return async (turn) => {
    const store = journal()
    if (!store || turn.stamps.length === 0) {
      return { covered: new Set(), paused: false }
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
    const fills: JournalConnectorReplyFill[] = []
    // Rows an earlier fill (recovery's, say) already answered for this same turn count too.
    const turnKey = `${turn.sessionId}\0${turn.turnItemId}`
    const answered = new Set([
      ...(answeredByTurn.get(turnKey) ?? []),
      ...rows
        .filter(
          (row) => row.fill?.outcome === 'answered' && row.fill.turnItemId === turn.turnItemId
        )
        .map((row) => row.conversation.externalId)
    ])
    const { outcome, prose } = connectorReplyTurnOutcome(turn)
    for (const row of own) {
      if (outcome === 'answered') {
        answered.add(row.conversation.externalId)
      }
      const conversation = JSON.stringify([row.account, row.conversation])
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
        ...(outcome === 'answered' && turn.tookMs !== undefined ? { tookMs: turn.tookMs } : {})
      })
    }
    if (await store.fillOutcomes(fills)) {
      filled()
    }
    if (answered.size > 0) {
      remember(turnKey, answered)
    }
    return { covered, paused: false, answered }
  }
}
