import {
  stableReplyId,
  stableSendUuid,
  type ConversationRow,
  type DingTalkExternalId,
  type DingTalkLedgerState,
  type InboxRow,
  type ReplyRow
} from './dingtalk-domain'

export type TurnObservation = {
  kind: 'turn-ended'
  source: string
  externalId: string
  turnId: number | null
  origin?: string
  lastAssistantMessage?: string
  /** The delivery that alone started this turn, from its turn-started event; it owns the turn. */
  deliveryId?: string
}

export type TurnAttribution =
  | { kind: 'reply'; reply: ReplyRow; inboxKeys: string[] }
  | {
      kind: 'ignore'
      reason:
        | 'wrong_source'
        | 'not_delivery'
        | 'missing_turn'
        | 'missing_text'
        | 'conversation_missing'
        | 'already_replied'
    }

export function attributeTurnEnded(
  state: DingTalkLedgerState,
  event: TurnObservation,
  now = Date.now(),
  sweepable: (row: InboxRow) => boolean = () => true
): TurnAttribution {
  if (event.source !== 'dingtalk') {
    return { kind: 'ignore', reason: 'wrong_source' }
  }
  if (event.origin !== 'delivery') {
    return { kind: 'ignore', reason: 'not_delivery' }
  }
  if (event.turnId === null) {
    return { kind: 'ignore', reason: 'missing_turn' }
  }
  const text = event.lastAssistantMessage?.trim()
  if (!text) {
    return { kind: 'ignore', reason: 'missing_text' }
  }
  const conversation = state.conversations[event.externalId]
  if (!conversation) {
    return { kind: 'ignore', reason: 'conversation_missing' }
  }
  const replyKey = stableReplyId(conversation.externalId, event.turnId)
  // A repeated completion must not attribute a newer delivered row to an older turn's reply.
  if (state.replies[replyKey]) {
    return { kind: 'ignore', reason: 'already_replied' }
  }
  const reply: ReplyRow = {
    key: replyKey,
    externalId: conversation.externalId,
    profile: conversation.profile,
    groupId: conversation.groupId,
    text,
    uuid: stableSendUuid(replyKey),
    turnId: event.turnId,
    state: 'queued',
    error: '',
    updatedAt: now
  }
  return { kind: 'reply', reply, inboxKeys: answeredInboxKeys(state, event, sweepable) }
}

/** The messages a turn answered: exactly the one delivery that started it, else every sweepable
 *  message of the conversation still in flight, since a busy chat folds those into its running turn. */
function answeredInboxKeys(
  state: DingTalkLedgerState,
  event: TurnObservation,
  sweepable: (row: InboxRow) => boolean
): string[] {
  const rows = Object.values(state.inbox).filter((row) => row.externalId === event.externalId)
  if (event.deliveryId) {
    return rows.filter((row) => row.deliveryId === event.deliveryId).map((row) => row.key)
  }
  return rows
    .filter((row) => (row.state === 'delivered' || row.state === 'delivering') && sweepable(row))
    .map((row) => row.key)
}

const turnKey = (externalId: string, turnId: number | null): string =>
  `${externalId}\u0000${turnId}`

/** One watch's turns: the delivery each named turn answers, and rows answered before they landed. */
export class DingTalkTurnDeliveries {
  // Kept until the turn's reply is stored, so a repeated or concurrent end stays on its own row.
  private readonly named = new Map<string, string>()
  private readonly answeredEarly = new Set<string>()
  private watchedSince = Number.POSITIVE_INFINITY

  /** A new watch: rows delivered before it belong to turns whose end it never hears. */
  watch(now = Date.now()): void {
    this.named.clear()
    this.answeredEarly.clear()
    this.watchedSince = now
  }

  start(externalId: string, at: number, deliveryId: string | undefined): void {
    if (deliveryId) {
      this.named.set(turnKey(externalId, at), deliveryId)
    }
  }

  attribute(
    state: DingTalkLedgerState,
    event: Omit<TurnObservation, 'deliveryId'>
  ): TurnAttribution {
    const key = turnKey(event.externalId, event.turnId)
    const deliveryId = this.named.get(key)
    const result = attributeTurnEnded(state, { ...event, deliveryId }, Date.now(), (row) =>
      this.sweepable(row)
    )
    if (result.kind === 'ignore' && result.reason !== 'already_replied') {
      this.named.delete(key)
    }
    return result
  }

  /** The turn's reply is stored and its rows claimed. */
  end(externalId: string, turnId: number | null): void {
    this.named.delete(turnKey(externalId, turnId))
  }

  answerEarly(inboxKey: string): void {
    this.answeredEarly.add(inboxKey)
  }

  /** Whether a turn answered this row before its delivery landed; answered once. */
  landed(inboxKey: string): boolean {
    return this.answeredEarly.delete(inboxKey)
  }

  private sweepable(row: InboxRow): boolean {
    return (
      row.updatedAt >= this.watchedSince &&
      !this.answeredEarly.has(row.key) &&
      ![...this.named.values()].includes(row.deliveryId)
    )
  }
}

export function conversationKeyFor(row: ConversationRow): {
  source: 'dingtalk'
  externalId: DingTalkExternalId
} {
  return { source: 'dingtalk', externalId: row.externalId }
}
